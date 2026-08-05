#!/usr/bin/env node
/**
 * pi-acp — A thin ACP (Agent Client Protocol) adapter that lets Buzz drive
 * the pi coding agent (@earendil-works/pi-coding-agent) as a managed agent,
 * the same way claude-agent-acp wraps Claude Code.
 *
 * Transport: NDJSON over stdio — one JSON-RPC 2.0 message per line.
 *   stdin  : Buzz(host) → adapter   requests + notifications
 *   stdout : adapter → Buzz(host)   responses + session/update notifications
 *   stderr : diagnostic log ONLY (never the wire)
 *
 * Buzz spawns this binary, then drives it with:
 *   initialize            → {protocolVersion, agentCapabilities, _meta}
 *   session/new           → {sessionId, configOptions, models}   params: {cwd, mcpServers, systemPrompt?}
 *   session/prompt        → {stopReason}        params: {sessionId, prompt:[{type:"text",text}]}
 *                          streams session/update {agent_message_chunk | tool_call | tool_call_update}
 *   session/cancel        (notification)        → session.abort()
 *   session/set_model     → {}                   params: {sessionId, modelId}
 *   session/set_config_option / authenticate    → {} (ack)
 *
 * Wire format mirrored from Buzz's AcpClient (crates/buzz-acp/src/acp.rs):
 * NDJSON lines, JSON-RPC 2.0; notifications carry no `id`.
 */

import readline from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

// ── ACP wire helpers ──────────────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...a) => process.stderr.write(`[pi-acp] ${a.join(" ")}\n`);
const ok = (id, result = {}) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) =>
	send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

/** Emit a `session/update` notification (the streaming channel Buzz reads). */
const sessionUpdate = (sessionId, update) =>
	notify("session/update", { sessionId, update });

// If a prompt produces NO events (text/tool/retry) for this long, the model
// call is stuck (hung connection, dead provider). Legit long tasks emit events
// continuously, so total silence means genuinely unresponsive — abort it.
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const ADAPTER_VERSION = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

function armWatchdog(sessionId, entry) {
	clearWatchdog(entry);
	entry.lastActivity = Date.now();
	entry.watchdog = setInterval(() => {
		if (!entry.promptId) return; // nothing in flight
		const idle = Date.now() - entry.lastActivity;
		if (idle >= INACTIVITY_TIMEOUT_MS) {
			clearWatchdog(entry);
			log("inactivity watchdog: aborting after", (idle / 1000) | 0, "s of silence");
			sessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: {
					text: `\n\n⏱️ No activity for ${((idle / 1000 / 60) | 0)} min — model unresponsive, aborting. Try again or switch model.`,
				},
			});
			entry.cancelled = true;
			entry.session.abort().catch((e) => log("watchdog abort:", e?.message));
		}
	}, 60_000);
}

function clearWatchdog(entry) {
	if (entry.watchdog) {
		clearInterval(entry.watchdog);
		entry.watchdog = null;
	}
}

// ── State ─────────────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId -> entry { session, unsubscribe, cancelled, models }
let initialized = false;

// Shared model runtime (lazy-init on first session/new so `initialize` stays
// fast and so we don't touch auth.json until a session is actually needed).
// Mirrors createAgentSession's internal construction (sdk.ts):
//   authPath = join(agentDir,"auth.json"), modelsPath = join(agentDir,"models.json")
let modelRuntime = null;
async function getModelRuntime() {
	if (!modelRuntime) {
		const agentDir = getAgentDir();
		modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
	}
	return modelRuntime;
}

/**
 * Build the ACP `configOptions` model list from pi's ModelRuntime, filtered to
 * providers with configured auth so the picker only offers usable models.
 * Returns { options: [{value,displayName}], byValue: Map<value, Model> }.
 * `value` is "provider/modelId" — the same string Buzz sends back in set_model.
 */
function buildModelOptions(runtime) {
	const options = [];
	const byValue = new Map();
	for (const provider of runtime.getProviders()) {
		const pid = provider.id;
		if (!runtime.hasConfiguredAuth(pid)) continue;
		for (const m of runtime.getModels(pid)) {
			const value = `${pid}/${m.id}`;
			if (byValue.has(value)) continue;
			const displayName = m.name || m.apiName || m.displayName || m.id;
			// `displayName` is the ACP spelling. Retain `label` for older hosts.
			options.push({ value, displayName, label: displayName });
			byValue.set(value, m);
		}
	}
	return { options, byValue };
}

/** Build a configOption with both ACP and legacy Buzz field spellings. */
function configOption({ configId, category, displayName, currentValue, options }) {
	return {
		configId,
		category,
		displayName,
		label: displayName,
		currentValue,
		// Buzz's profile cache also accepts `value`; emitting both keeps the
		// selected option visible across ACP client versions.
		value: currentValue,
		options,
	};
}

function buildThinkingOption(session) {
	const currentValue = session.thinkingLevel || "off";
	return configOption({
		configId: "thinking",
		category: "effort",
		displayName: "Thinking / Effort",
		currentValue,
		options: THINKING_LEVELS.map((value) => ({
			value,
			displayName: value,
			label: value,
		})),
	});
}

/** ACP's unstable model-state shape, used by Buzz to cache the active model. */
function buildModelState(entry) {
	return {
		currentModelId: currentValue(entry),
		availableModels: entry.models.options.map((option) => ({
			modelId: option.value,
			name: option.displayName,
		})),
	};
}

/** Resolve any modelId string Buzz might send back to a Model object. */
function resolveModel(entry, modelId) {
	if (!modelId) return undefined;
	// 1. exact value match (what we surfaced)
	if (entry.models?.byValue.has(modelId)) return entry.models.byValue.get(modelId);
	// 2. "provider/modelId" parse
	if (modelId.includes("/")) {
		const [p, ...rest] = modelId.split("/");
		const mid = rest.join("/");
		const m = entry.models?.byValue.get(`${p}/${mid}`);
		if (m) return m;
	}
	// 3. fuzzy: any surfaced model whose id matches
	for (const m of entry.models?.byValue.values() ?? []) {
		if (m.id === modelId || m.id === modelId.split("/").pop()) return m;
	}
	return undefined;
}

// ── pi session lifecycle ──────────────────────────────────────────────────
/**
 * Create a pi AgentSession and wire its event stream into ACP `session/update`
 * notifications. Buzz's `systemPrompt` (base_prompt + persona) is APPENDED to
 * pi's own system prompt via DefaultResourceLoader.appendSystemPrompt, so pi
 * keeps all its tool docs / skills / context AND gains Buzz's rules.
 */
async function newPiSession(sessionId, { cwd, mcpServers, systemPrompt } = {}) {
	for (const [, s] of sessions) {
		try {
			s.unsubscribe?.();
			s.session.dispose();
		} catch {}
	}
	sessions.clear();

	const runtime = await getModelRuntime();
	const agentDir = getAgentDir();
	if (Array.isArray(mcpServers) && mcpServers.length > 0) {
		// Pi intentionally has no built-in MCP client. Do not claim these servers
		// are available to the model merely because an ACP host supplied them.
		log("session/new: MCP servers supplied but unsupported by pi; ignoring", mcpServers.length);
	}

	// Append Buzz's system prompt (collaboration rules + persona) to pi's own.
	const loader = new DefaultResourceLoader({
		cwd: cwd || process.cwd(),
		agentDir,
		appendSystemPrompt: systemPrompt ? [systemPrompt] : undefined,
	});
	// createAgentSession only reload()s a loader it built itself; since we supply
	// our own, we must trigger the load that populates appendSystemPrompt.
	await loader.reload();

	const created = await createAgentSession({
		cwd: cwd || undefined,
		modelRuntime: runtime,
		resourceLoader: loader,
	});
	const session = created.session;

	const models = buildModelOptions(runtime);
	// If pi's default model isn't in our surfaced list (e.g. its provider has
	// no configured auth), switch to the first available model before any
	// prompt runs, so the session never starts on an unusable model.
	const cur = session.model;
	if (cur && !models.byValue.has(`${cur.provider}/${cur.id}`) && models.options.length > 0) {
		const fallback = models.byValue.get(models.options[0].value);
		if (fallback) {
			try {
				await session.setModel(fallback);
				log("default model was unavailable, switched to", models.options[0].value);
			} catch (e) {
				log("could not switch default model:", e?.message);
			}
		}
	}
	// Enable auto-retry so transient model errors (provider hiccups, brief rate
	// limits) self-heal instead of surfacing as a hard failure. Each retry is
	// surfaced to the host via auto_retry_* events (handled below).
	try {
		session.setAutoRetryEnabled(true);
	} catch (e) {
		log("could not enable auto-retry:", e?.message || e);
	}
	const entry = { session, cancelled: false, promptId: null, models, producedText: false, lastActivity: 0, watchdog: null,
		_systemPrompt: systemPrompt, _cwd: cwd || process.cwd() };
	const unsubscribe = session.subscribe((event) => {
		try {
			handlePiEvent(sessionId, entry, event);
		} catch (e) {
			log("event handler error:", e?.message || e);
		}
	});
	entry.unsubscribe = unsubscribe;
	sessions.set(sessionId, entry);
	return entry;
}

/** The current model as a "provider/modelId" value (for configOptions state). */
function currentValue(entry) {
	const m = entry.session.model;
	return m ? `${m.provider}/${m.id}` : undefined;
}

/**
 * Translate a pi AgentSessionEvent into ACP `session/update` notifications.
 * Text deltas → agent_message_chunk; tool calls → tool_call + tool_call_update.
 *
 * pi delivers a tool call as a `message_update` whose assistantMessageEvent
 * type is `toolcall_end` (carrying the full {id,name,arguments}), followed
 * by top-level `tool_execution_start` / `tool_execution_end` events that
 * carry the same `toolCallId`. We emit the ACP `tool_call` on `toolcall_end`
 * and the status transitions on execution start/end.
 */
function handlePiEvent(sessionId, entry, event) {
	const { type } = event;
	entry.lastActivity = Date.now(); // any event resets the inactivity watchdog

	if (type === "message_update") {
		const ame = event.assistantMessageEvent;
		if (!ame) return;
		if (ame.type === "text_delta" && ame.delta) {
			entry.producedText = true;
			sessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { text: ame.delta },
			});
		} else if (ame.type === "thinking_delta" && ame.delta) {
			// Reasoning / chain-of-thought → agent_thought_chunk so the desktop
			// renders it in the “Thinking” panel instead of swallowing it.
			sessionUpdate(sessionId, {
				sessionUpdate: "agent_thought_chunk",
				content: { text: ame.delta },
			});
		} else if (ame.type === "toolcall_end" && ame.toolCall) {
			const tc = ame.toolCall;
			const upd = {
				sessionUpdate: "tool_call",
				toolCallId: String(tc.id || randomUUID()),
				title: String(tc.name || "tool"),
				toolName: String(tc.name || "tool"),
				kind: "function",
			};
			// Desktop reads update.arguments (object), not content.text (string).
			if (tc.arguments != null) upd.arguments = tc.arguments;
			sessionUpdate(sessionId, upd);
		}
		// thinking_start/thinking_end: stream boundaries, no content to forward.
	} else if (type === "tool_execution_start") {
		if (event.toolCallId)
			sessionUpdate(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: String(event.toolCallId),
				status: "running",
			});
	} else if (type === "tool_execution_end") {
		if (event.toolCallId) {
			const upd = {
				sessionUpdate: "tool_call_update",
				toolCallId: String(event.toolCallId),
				status: event.isError ? "failed" : "completed",
			};
			if (event.result != null) upd.result = event.result;
			sessionUpdate(sessionId, upd);
		}
	} else if (type === "compaction_start") {
		// pi is summarizing — surface progress so the UI doesn't look frozen
		// during the LLM call that generates the summary.
		entry.producedText = true;
		sessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { text: "\n\n📦 Compacting context…" },
		});
	} else if (type === "compaction_end") {
		if (event.aborted || event.errorMessage) {
			sessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { text: `\n\n⚠️ Compaction ${event.aborted ? "aborted" : "failed"}${event.errorMessage ? ": " + event.errorMessage : ""}` },
			});
		}
		// Success case is handled by the /compact interceptor's own response.
	} else if (type === "auto_retry_start") {
		// Model errored and pi is retrying with backoff. auto_retry_* events are
		// part of the subscribe stream, so surface them — otherwise the UI shows
				// nothing during the silent retry window (looks frozen).
		entry.producedText = true;
		sessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: {
				text: `\n\n⚠️ Model error (retry ${event.attempt}/${event.maxAttempts}): ${event.errorMessage || "unknown"} — retrying…`,
			},
		});
	} else if (type === "auto_retry_end") {
		if (event.success === false)
			sessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: {
					text: `\n\n❌ All retries exhausted: ${event.finalError || "model error"}`,
				},
		});
	}
}

function truncate(s, n = 400) {
	return s && s.length > n ? s.slice(0, n) + "…" : s;
}

// ── Request dispatch ──────────────────────────────────────────────────────
async function handleMessage(msg) {
	if (!msg || typeof msg !== "object") return;
	const { id, method, params } = msg;
	const hasId = id !== undefined;
	log("<-", method, hasId ? `id=${id}` : "(notif)", method === "session/prompt" ? `sessionId=${params?.sessionId?.slice(0,8)}` : "");

	if (method === "initialize") {
		initialized = true;
		log(
			"initialize from host:",
			JSON.stringify(params?.clientInfo || params?.clientCapabilities || {}),
		);
		return ok(id, {
			protocolVersion: 2,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: false },
				// Pi has no built-in MCP transport. session/new therefore logs and
				// ignores mcpServers rather than advertising unsupported capability.
				mcpCapabilities: { http: false, sse: false },
			},
			agentInfo: { name: "pi", version: ADAPTER_VERSION },
			_meta: { steering: { supported: false } },
		});
	}

	if (!initialized) {
		if (hasId) fail(id, -32002, "server not initialized");
		return;
	}

	switch (method) {
		case "session/new": {
			const sessionId = randomUUID();
			try {
				const entry = await newPiSession(sessionId, params || {});
				const cur = currentValue(entry);
				const result = {
					sessionId,
					// Return the stable configOption and unstable SessionModelState
					// forms. Buzz uses these to render and cache the active model.
					configOptions: [
						configOption({
							configId: "model",
							category: "model",
							displayName: "Model",
							currentValue: cur,
							options: entry.models.options,
						}),
						buildThinkingOption(entry.session),
					],
					models: buildModelState(entry),
				};
				log(
					"session/new:",
					sessionId,
					"cwd=",
					params?.cwd,
					"models=",
					entry.models.options.length,
					"sysprompt=",
					params?.systemPrompt ? `${params.systemPrompt.length}ch` : "none",
				);
				return ok(id, result);
			} catch (e) {
				log("session/new failed:", e?.stack || e);
				return fail(
					id,
					-32603,
					`failed to create pi session: ${e?.message || e}`,
				);
			}
		}

		case "session/prompt": {
			const sessionId = params?.sessionId;
			const entry = sessions.get(sessionId);
			if (!entry) return fail(id, -32602, `unknown sessionId: ${sessionId}`);

			const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
			const allText = blocks
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n\n");

			// Buzz's slash-command pass-through sends the bare command as the first
			// prompt block, then the wrapped Buzz context as subsequent blocks.
			// Check the FIRST block for a slash command — the full joined text
			// includes context so it would never match "/compact" exactly.
			const firstBlockText = blocks
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text)[0] ?? "";
			const firstLine = firstBlockText.trim();
			const text = allText; // keep for the normal prompt path below

			entry.cancelled = false;
			entry.promptId = id;
			entry.producedText = false;

			// ── Slash command interception ────────────────────────────────────
			// pi-acp sits between Buzz and the pi SDK. Buzz sends slash commands
			// (from the composer toolbar) as prompt text with a "/" prefix. The pi
			// SDK's interactive mode handles these natively, but session.prompt()
			// does NOT — it forwards raw text to the model. Intercept here so
			// /compact and /reset are handled locally, matching pi's own CLI.
			if (firstLine === "/compact" || firstLine.startsWith("/compact ")) {
				const customInstructions = firstLine.startsWith("/compact ")
					? firstLine.slice(9).trim() || undefined
					: undefined;
				armWatchdog(sessionId, entry);
				try {
					const result = await entry.session.compact(customInstructions);
					clearWatchdog(entry);
					const before = result?.tokensBefore ?? "?";
					const after = result?.estimatedTokensAfter ?? "?";
					sessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: {
							text: `\n\n📦 Context compacted: ${before} → ${after} tokens.`,
						},
					});
					entry.promptId = null;
					return ok(id, { stopReason: "end_turn" });
				} catch (e) {
					clearWatchdog(entry);
					entry.promptId = null;
					log("compact failed:", e?.stack || e);
					sessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { text: `\n\n❌ Compaction failed: ${e?.message || e}` },
					});
					return ok(id, { stopReason: "end_turn" });
				}
			}
			if (firstLine === "/reset") {
				// pi's AgentSession has no clear() method — the interactive CLI's
				// /reset wipes in-memory history. In ACP we must keep the same
				// session id, so dispose the current pi session and create a new
				// one in its place. The Buzz-side session id stays stable.
				try {
					entry.unsubscribe?.();
					entry.session.dispose();
				} catch (e) {
					log("/reset dispose failed:", e?.message);
				}
				try {
					const sysPrompt = entry._systemPrompt;
					const newEntry = await newPiSession(sessionId, {
						cwd: entry._cwd,
						systemPrompt: sysPrompt,
					});
					// newPiSession already sets sessions.set(sessionId, newEntry)
				} catch (e) {
					log("/reset re-create failed:", e?.stack || e);
					sessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { text: `\n\n❌ Reset failed: ${e?.message || e}` },
					});
				}
				sessionUpdate(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { text: "\n\n🗑️ Conversation history cleared." },
				});
				entry.promptId = null;
				return ok(id, { stopReason: "end_turn" });
			}

			armWatchdog(sessionId, entry);
			try {
				await entry.session.prompt(text);
				clearWatchdog(entry);
				// If the model produced nothing (silent error with retry disabled, or
				// an empty turn), surface it so the UI isn't a blank spinner.
				if (!entry.producedText && !entry.cancelled) {
					sessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: {
							text: "\n\n❌ No response from model (possible error). Try again or switch model.",
						},
					});
				}
				const stopReason = entry.cancelled ? "cancelled" : "end_turn";
				entry.promptId = null;
				return ok(id, { stopReason });
			} catch (e) {
				clearWatchdog(entry);
				entry.promptId = null;
				if (entry.cancelled) return ok(id, { stopReason: "cancelled" });
				log("prompt failed:", e?.stack || e);
				sessionUpdate(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { text: `\n\n[pi-acp error: ${e?.message || e}]` },
				});
				return ok(id, { stopReason: "end_turn" });
			}
		}

		case "session/set_model": {
			const sessionId = params?.sessionId;
			const entry = sessions.get(sessionId);
			const modelId = params?.modelId;
			if (!entry) return fail(id, -32602, `unknown sessionId: ${sessionId}`);
			const model = resolveModel(entry, modelId);
			if (!model) {
				log("set_model: could not resolve", modelId);
				return fail(id, -32602, `unknown model: ${modelId}`);
			}
			try {
				await entry.session.setModel(model);
				log("set_model:", modelId);
				return ok(id, {});
			} catch (e) {
				log("set_model failed:", e?.message);
				return fail(id, -32603, `set_model failed: ${e?.message || e}`);
			}
		}

		case "session/cancel": {
			const sessionId = params?.sessionId;
			const entry = sessions.get(sessionId);
			if (entry) {
				entry.cancelled = true;
				try {
					await entry.session.abort();
				} catch (e) {
					log("abort:", e?.message);
				}
			}
			return; // notification — do NOT respond
		}

		case "session/set_config_option": {
			// buzz-acp uses this stable path for configOptions, including model
			// changes. Apply every option we advertise; never ACK a rejected value.
			const sessionId = params?.sessionId;
			const configId = params?.configId;
			const cfgValue = params?.value;
			log("set_config_option:", configId, "=", cfgValue);
			const cfgEntry = sessions.get(sessionId);
			if (!cfgEntry) {
				return hasId
					? fail(id, -32602, `unknown sessionId: ${sessionId}`)
					: undefined;
			}
			if (typeof cfgValue !== "string" || !cfgValue) {
				return hasId
					? fail(id, -32602, `missing value for config option: ${configId}`)
					: undefined;
			}
			if (configId === "model") {
				const model = resolveModel(cfgEntry, cfgValue);
				if (!model) {
					return hasId ? fail(id, -32602, `unknown model: ${cfgValue}`) : undefined;
				}
				try {
					await cfgEntry.session.setModel(model);
					log("set_config_option: applied model", cfgValue);
					return hasId ? ok(id, {}) : undefined;
				} catch (e) {
					log("set_config_option: setModel failed:", e?.message);
					return hasId
						? fail(id, -32603, `set_model failed: ${e?.message || e}`)
						: undefined;
				}
			}
			if (configId === "thinking" || configId === "effort") {
				if (!THINKING_LEVELS.includes(cfgValue)) {
					return hasId
						? fail(id, -32602, `unsupported thinking level: ${cfgValue}`)
						: undefined;
				}
				cfgEntry.session.setThinkingLevel(cfgValue);
				log("set_config_option: applied thinking level", cfgValue);
				return hasId ? ok(id, {}) : undefined;
			}
			return hasId
				? fail(id, -32602, `unknown config option: ${configId}`)
				: undefined;
		}
		case "authenticate":
			return hasId ? ok(id, {}) : undefined;

		default:
			if (hasId) return fail(id, -32601, `method not found: ${method}`);
	}
}

// ── stdin loop (NDJSON, one JSON-RPC message per line) ────────────────────
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		log("unparseable line (skipped):", trimmed.slice(0, 200));
		return;
	}
	Promise.resolve(handleMessage(msg)).catch((e) =>
		log("handler threw:", e?.stack || e),
	);
});

rl.on("close", async () => {
	log("stdin closed — shutting down");
	for (const [, s] of sessions) {
		try {
			s.unsubscribe?.();
			s.session.dispose();
		} catch {}
	}
	process.exit(0);
});

process.on("uncaughtException", (e) => log("uncaught:", e?.stack || e));
process.on("unhandledRejection", (e) =>
	log("unhandledRejection:", e?.stack || e),
);

log("pi-acp v2 ready (ACP over NDJSON stdio)");
