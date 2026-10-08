// Codemode activation regression (SDK 1.0.4 codemode/MCP fix).
//
// The codemode tool registers INACTIVE in the SDK; it activates for a session
// only via the settings `defaultTools` entry "+codemode" (or --tools). The
// adapter must (a) register the built-in extension factories at all — the SDK
// does not do this for its hosts — and (b) surface the tool as ACTIVE, not
// merely registered. Presence alone is not enough: a registered-but-inactive
// tool is invisible to the model.
//
// Proof: run the adapter with a hermetic PI_CODING_AGENT_DIR (temp dir, no
// real user state, no model auth needed — activation happens at
// session_start, before any prompt), send session/new, and read the
// post-bind diagnostic the adapter logs to stderr:
//   [pi-acp] active tools: <names>
//   1. defaultTools: ["+codemode"] → codemode MUST be in the active list.
//   2. defaultTools: ["read"]      → read active, codemode NOT active —
//      proves activation is driven by the settings entry, not registration.
//      (SDK: the settings defaultTools array replaces the built-in default
//      tool list; codemode registers with defaultActive:false.)
//   3. AGENT_PROFILE=persona-permit (tools: read, bash, codemode) with the
//      persona-filter fixture (a faithful mirror of pi-open-agents 0.1.22
//      applyTools) → builtin whitelist trims grep/find/ls/powershell; read,
//      bash and codemode stay active. Proves the persona filter actually ran
//      AND that a persona permitting codemode keeps it usable.
//   4. AGENT_PROFILE=persona-strict (tools: read) → the whitelist trims
//      builtin tools to {read}, but codemode (sourceInfo.source = "inline",
//      registered by the SDK built-in extension factory) is KEPT: the
//      pi-open-agents gate only restricts builtin-sourced tools. This is the
//      real least-privilege boundary of the live persona mechanism — a
//      restrictive persona whitelist CANNOT deactivate codemode. Excluding
//      a non-builtin tool requires the SDK's allowedToolNames gate
//      (createAgentSession tools/noTools), not the persona file. The test
//      asserts the observed (real) behavior so any future change to the
//      filter semantics is caught here.
//
// Hermeticity mirrors test/lifecycle.mjs: every scenario gets a fresh
// mkdtemp agent dir and a plain temp project cwd; the test never touches the
// user's real ~/.pi/agent/ state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

function createHermeticAgentDir(defaultTools, personaProfile = null) {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-codemode-"));
	mkdirSync(dir, { recursive: true });
	const settings = { defaultTools };
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	if (personaProfile) {
		// Persona-filter scenarios: install the mirror fixture of the live
		// pi-open-agents tool filter plus the persona .md files it reads.
		mkdirSync(join(dir, "extensions"), { recursive: true });
		copyFileSync(
			join(here, "fixtures", "persona-filter-fixture.js"),
			join(dir, "extensions", "persona-filter-fixture.js"),
		);
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(
			join(dir, "agents", "persona-permit.md"),
			"---\nname: persona-permit\ntools: read, bash, codemode\n---\n\npermitting persona\n",
		);
		writeFileSync(
			join(dir, "agents", "persona-strict.md"),
			"---\nname: persona-strict\ntools: read\n---\n\nstrict persona\n",
		);
	}
	return dir;
}

function runAdapter({ defaultTools, agentProfile = null }) {
	const tempAgentDir = createHermeticAgentDir(defaultTools, agentProfile);
	const tempProject = mkdtempSync(join(tmpdir(), "pi-acp-codemode-proj-"));
	const env = { ...process.env };
	delete env.PI_ACP_TEST_CWD;
	delete env.PI_ACP_TEST_SESSION_DIR;
	delete env.PI_TRUST_STORE;
	if (agentProfile === null) {
		delete env.AGENT_PROFILE;
	} else {
		env.AGENT_PROFILE = agentProfile;
	}
	env.PI_CODING_AGENT_DIR = tempAgentDir;

	const child = spawn("node", [resolve(here, "..", "pi-acp.mjs")], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});
	const rl = readline.createInterface({ input: child.stdout });
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));

	rl.on("line", (line) => {
		const message = JSON.parse(line);
		const resolveFn = pending.get(message.id);
		if (resolveFn) {
			pending.delete(message.id);
			resolveFn(message);
		}
	});

	function request(method, params) {
		const id = nextId++;
		return new Promise((resolveFn, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timed out waiting for ${method}`));
			}, 30_000);
			pending.set(id, (message) => {
				clearTimeout(timeout);
				resolveFn(message);
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	return { child, request, getStderr: () => stderr, tempAgentDir, tempProject };
}

function activeToolsLine(stderr) {
	const match = stderr.split("\n").find((l) => l.includes("active tools:"));
	return match ? match.split("active tools:")[1].trim() : null;
}

function activeToolNames(stderr) {
	const line = activeToolsLine(stderr);
	return line ? line.split(/,\s*/).filter(Boolean) : [];
}

let failures = 0;

// ── Scenario 1: defaultTools "+codemode" → active ─────────────────────────
{
	const { child, request, getStderr, tempAgentDir, tempProject } = runAdapter({
		defaultTools: ["+codemode"],
	});
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "codemode-on" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: tempProject, mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");
		assert.equal(typeof created.result.sessionId, "string");

		const active = activeToolsLine(getStderr());
		const pass = active !== null && /(^|[,\s])codemode([,\s]|$)/.test(active);
		console.log(
			`① defaultTools [+codemode] → active tools: "${active ?? "(missing)"}": ${pass ? "PASS ✓" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
		rmSync(tempAgentDir, { recursive: true, force: true });
		rmSync(tempProject, { recursive: true, force: true });
	}
}

// ── Scenario 2: no "+codemode" entry → registered but NOT active ───────────
// The settings defaultTools array replaces the built-in default list, so the
// session still has the named base tool ("read"); the point is that codemode
// is absent from the active set without its explicit activation entry.
{
	const { child, request, getStderr, tempAgentDir, tempProject } = runAdapter({
		defaultTools: ["read"],
	});
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "codemode-off" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: tempProject, mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");

		const active = activeToolsLine(getStderr());
		const readActive = active !== null && /(^|[,\s])read([,\s]|$)/.test(active);
		const codemodeInactive = active !== null && !/(^|[,\s])codemode([,\s]|$)/.test(active);
		const pass = readActive && codemodeInactive;
		console.log(
			`② defaultTools [read] → active tools: "${active ?? "(missing)"}": ${pass ? "PASS ✓ (read active, codemode correctly inactive)" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
		rmSync(tempAgentDir, { recursive: true, force: true });
		rmSync(tempProject, { recursive: true, force: true });
	}
}

// ── Scenario 3: persona permitting codemode (global +codemode enabled) ──────
// The persona-filter fixture runs pi-open-agents' real filter in session_start
// and trims builtin tools to the persona whitelist; codemode (inline) is kept
// unconditionally. The whitelist trimming is the proof the persona gate ran.
{
	const { child, request, getStderr, tempAgentDir, tempProject } = runAdapter({
		defaultTools: ["+codemode"],
		agentProfile: "persona-permit",
	});
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "persona-permit" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: tempProject, mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");

		const names = activeToolNames(getStderr());
		const filterRan = getStderr().includes("[persona-fixture] profile=persona-permit");
		const readActive = names.includes("read");
		const bashActive = names.includes("bash");
		const codemodeActive = names.includes("codemode");
		const builtinTrimmed = !names.includes("grep") && !names.includes("ls");
		const pass = filterRan && readActive && bashActive && codemodeActive && builtinTrimmed;
		console.log(
			`③ persona-permit (tools: read, bash, codemode) → active: "${names.join(", ")}": ${pass ? "PASS ✓ (whitelist ran; codemode kept active)" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
		rmSync(tempAgentDir, { recursive: true, force: true });
		rmSync(tempProject, { recursive: true, force: true });
	}
}

// ── Scenario 4: restrictive persona (tools: read) — the real gate boundary ──
// pi-open-agents' whitelist only restricts builtin-sourced tools; codemode
// (source: "inline") survives it. Assert the OBSERVED real behavior — and if
// the SDK/extension filter semantics ever change, this scenario fails loudly.
{
	const { child, request, getStderr, tempAgentDir, tempProject } = runAdapter({
		defaultTools: ["+codemode"],
		agentProfile: "persona-strict",
	});
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "persona-strict" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: tempProject, mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");

		const names = activeToolNames(getStderr());
		const filterRan = getStderr().includes("[persona-fixture] profile=persona-strict");
		const readActive = names.includes("read");
		const builtinTrimmed = !names.includes("bash") && !names.includes("grep");
		const codemodeKept = names.includes("codemode");
		const pass = filterRan && readActive && builtinTrimmed && codemodeKept;
		console.log(
			`④ persona-strict (tools: read) → active: "${names.join(", ")}": ${pass ? "PASS ✓ (builtin whitelist trimmed; codemode kept — inline tools are outside the persona whitelist gate)" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
		rmSync(tempAgentDir, { recursive: true, force: true });
		rmSync(tempProject, { recursive: true, force: true });
	}
}

if (failures > 0) {
	console.error(`${failures} codemode regression scenario(s) FAILED`);
	process.exit(1);
}
console.log("codemode regression: all scenarios passed");
