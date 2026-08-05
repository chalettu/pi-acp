// ACP client that drives pi-acp.mjs end-to-end like Buzz, and verifies the
// v2 enhancements: configOptions model list + systemPrompt forwarding.
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const SECRET = "BUZZ-MARKER-9241";
// A distinctive system prompt we expect pi to append + obey.
const sysPrompt = `You are a Buzz-managed agent. Additional rule: if asked for the
secret marker, reply with exactly: ${SECRET}. Otherwise answer normally.`;

let nextId = 1;
const pending = new Map();
let sessionId = null;
let streamed = "";
let toolCalls = 0;

const child = spawn("node", ["pi-acp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });
const send = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		child.stdin.write(
			JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
		);
	});

rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
		return;
	}
	if (msg.method === "session/update") {
		const u = msg.params?.update;
		if (u?.sessionUpdate === "agent_message_chunk" && u.content?.text != null) {
			streamed += u.content.text;
			process.stdout.write(u.content.text);
		} else if (u?.sessionUpdate === "tool_call") {
			toolCalls++;
			console.log(`\n[tool_call] ${u.title}`);
		}
	}
});

await send("initialize", {
	protocolVersion: 2,
	clientCapabilities: {},
	clientInfo: { name: "e2e-v2" },
});

const created = await send("session/new", { cwd: "/tmp", systemPrompt: sysPrompt });
sessionId = created.result.sessionId;

// ① configOptions carry both the selectable models and the current model.
const modelConfig = created.result.configOptions?.find((o) => o.category === "model");
const opts = modelConfig?.options ?? [];
const thinkingConfig = created.result.configOptions?.find((o) => o.category === "effort");
const stateMatches =
	modelConfig?.currentValue === created.result.models?.currentModelId &&
	modelConfig?.value === modelConfig?.currentValue;
console.log(`① models surfaced: ${opts.length}; current model state: ${stateMatches ? "PASS ✓" : "FAIL ✗"}`);
if (opts.length) console.log("   sample:", opts.slice(0, 3).map((o) => o.value).join(", "));
console.log(`   thinking config: ${thinkingConfig?.currentValue ? "PASS ✓" : "FAIL ✗"}`);

// ③ Buzz selects a model through the stable configOptions path.
let setOk = false;
if (opts.length > 0) {
	const target = opts[0].value;
	const sm = await send("session/set_config_option", {
		sessionId,
		configId: "model",
		value: target,
	});
	setOk = !sm.error;
	console.log(`③ set_config_option(model, "${target}"): ${setOk ? "PASS ✓" : "FAIL ✗"}${sm.error ? " — " + sm.error.message : ""}`);
} else {
	console.log("③ model selection: skipped (no authenticated models)");
	setOk = true;
}

const effort = await send("session/set_config_option", {
	sessionId,
	configId: "thinking",
	value: "medium",
});
const effortOk = !effort.error;
console.log(`   set_config_option(thinking, "medium"): ${effortOk ? "PASS ✓" : "FAIL ✗"}`);

// ② systemPrompt actually forwarded into pi? Ask for the secret marker.
console.log("\n--- prompt: reveal secret marker ---");
streamed = "";
const done = await send("session/prompt", {
	sessionId,
	prompt: [{ type: "text", text: "What is the secret marker? Just the marker." }],
});
console.log(`\n--- stopReason: ${done.result?.stopReason} ---`);
const ok = streamed.includes(SECRET);
console.log(`② systemPrompt forwarded: ${ok ? "PASS ✓" : "FAIL ✗"}`);
console.log(`   reply: ${streamed.trim().slice(0, 80)}`);

// ④ tool activity surfaces as tool_call notifications?
console.log("\n--- prompt: force tool use ---");
toolCalls = 0;
const tdone = await send("session/prompt", {
	sessionId,
	prompt: [{ type: "text", text: "Use your ls tool to list files in the current directory, then say 'done'." }],
});
console.log(`④ tool_call notifications: ${toolCalls} → ${toolCalls > 0 ? "PASS ✓" : "FAIL ✗"}`);
console.log(`   stopReason: ${tdone.result?.stopReason}`);

child.stdin.end();
await new Promise((r) => child.on("exit", r));
process.exit(ok && stateMatches && !!thinkingConfig?.currentValue && setOk && effortOk && toolCalls > 0 ? 0 : 1);
