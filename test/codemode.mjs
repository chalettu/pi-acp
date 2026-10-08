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
//
// Hermeticity mirrors test/lifecycle.mjs: every scenario gets a fresh
// mkdtemp agent dir and a plain temp project cwd; the test never touches the
// user's real ~/.pi/agent/ state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

function createHermeticAgentDir(defaultTools) {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-codemode-"));
	mkdirSync(dir, { recursive: true });
	const settings = { defaultTools };
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	return dir;
}

function runAdapter({ defaultTools }) {
	const tempAgentDir = createHermeticAgentDir(defaultTools);
	const tempProject = mkdtempSync(join(tmpdir(), "pi-acp-codemode-proj-"));
	const env = { ...process.env };
	delete env.PI_ACP_TEST_CWD;
	delete env.PI_ACP_TEST_SESSION_DIR;
	delete env.PI_TRUST_STORE;
	delete env.AGENT_PROFILE;
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

if (failures > 0) {
	console.error(`${failures} codemode regression scenario(s) FAILED`);
	process.exit(1);
}
console.log("codemode regression: all scenarios passed");
