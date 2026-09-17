// Lifecycle regression: a flag set BEFORE bindExtensions must be visible to an
// extension during session_start.
//
// This is the exact ordering defect the AGENT_PROFILE fix addresses. pi-open-agents
// reads pi.getFlag("agent") inside its session_start handler, and the SDK's
// bindExtensions() fires session_start on its LAST step — so the adapter must set
// the flag before binding. We prove the ordering with a repo-local fixture
// extension (test/fixtures/agent-flag-fixture.mjs) rather than depending on Chris's
// globally installed pi-open-agents package, so the test is portable.
//
// Two scenarios:
//   1. AGENT_PROFILE set  → the fixture must observe the value during session_start.
//   2. AGENT_PROFILE unset → the fixture must observe (none) — no profile applied.
//
// Both must pass for the adapter to be correct.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/agent-flag-fixture.mjs");

function runAdapter({ agentProfile }) {
	const env = { ...process.env, PI_ACP_TEST_EXTENSION_PATH: FIXTURE };
	delete env.AGENT_PROFILE;
	if (agentProfile) env.AGENT_PROFILE = agentProfile;

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

	return { child, request, getStderr: () => stderr };
}

function observedFlag(stderr) {
	const match = stderr.match(/AGENT_FLAG_SEEN=([^\n]*)/);
	return match ? match[1] : null;
}

let failures = 0;

// ── Scenario 1: AGENT_PROFILE set → fixture sees the value ─────────────────
{
	const { child, request, getStderr } = runAdapter({ agentProfile: "tech-lead" });
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "lifecycle-set" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");
		assert.equal(typeof created.result.sessionId, "string");

		const seen = observedFlag(getStderr());
		const pass = seen === "tech-lead";
		console.log(
			`① AGENT_PROFILE=tech-lead → fixture observed "${seen ?? "nothing"}": ${pass ? "PASS ✓" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
	}
}

// ── Scenario 2: AGENT_PROFILE unset → fixture sees (none) ──────────────────
{
	const { child, request, getStderr } = runAdapter({ agentProfile: undefined });
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "lifecycle-none" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");

		const seen = observedFlag(getStderr());
		const pass = seen === "(none)";
		console.log(
			`② AGENT_PROFILE unset → fixture observed "${seen ?? "nothing"}": ${pass ? "PASS ✓" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
	}
}

if (failures > 0) {
	console.error(`\n✗ ${failures} lifecycle regression check(s) failed`);
	process.exit(1);
}
console.log("\n✓ lifecycle regression: flag set before bindExtensions is visible during session_start");
process.exit(0);
