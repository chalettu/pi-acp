// Lifecycle + project-trust regression for the AGENT_PROFILE fix.
//
// Part A — lifecycle ordering: a flag set BEFORE bindExtensions must be visible
// to an extension during session_start. This is the exact ordering defect the
// AGENT_PROFILE fix addresses. pi-open-agents reads pi.getFlag("agent") inside
// its session_start handler, and the SDK's bindExtensions() fires session_start
// on its LAST step — so the adapter must set the flag before binding. We prove
// the ordering with a repo-local fixture extension
// (test/fixtures/project/.pi/extensions/agent-flag-fixture.js) rather than
// depending on a globally installed pi-open-agents package, so the test is
// portable. The fixture is discovered through pi's normal project-extension
// path: session/new passes the fixture project as cwd, and pi auto-loads
// <cwd>/.pi/extensions/ (when the project is trusted).
//   1. AGENT_PROFILE set  → the fixture must observe the value during session_start.
//   2. AGENT_PROFILE unset → the fixture must observe (none) — no profile applied.
//
// Part B — project-trust boundary: the adapter must preserve the SDK trust gate
// instead of bypassing it (it previously loaded project extensions without
// resolving trust, so an untrusted project's .pi/extensions/ would execute).
//   3. Untrusted project → the fixture must NOT execute (no AGENT_FLAG_SEEN).
//   4. Explicitly trusted project → the fixture must execute (AGENT_FLAG_SEEN).
//
// Part B drives a HERMETIC trust store via PI_TRUST_STORE (a supported test
// override, not a production backdoor): it points the adapter at a temp
// trust.json so the trust decision is controlled in-memory rather than mutating
// the user's real ~/.pi/agent/trust.json. The fixture project is NOT trusted
// in the store, so scenario 3 exercises the untrusted path and scenario 4 adds
// an explicit trust entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
// The fixture project: its .pi/extensions/ holds the fixture extension, so the
// adapter discovers it through pi's standard project-extension path. No other
// project resources are present, so the session stays hermetic.
const FIXTURE_PROJECT = resolve(here, "fixtures/project");
// Hermetic trust store for the project-trust regression: a temp dir holding a
// trust.json we control, so the decision is deterministic and we never mutate
// the user's real ~/.pi/agent/trust.json.
const TRUST_DIR = resolve(here, "fixtures", "trust");
rmSync(TRUST_DIR, { recursive: true, force: true });
mkdirSync(TRUST_DIR, { recursive: true });

function runAdapter({ agentProfile, trusted = false, trustStore = null }) {
	const env = { ...process.env };
	delete env.PI_ACP_TEST_CWD; // removed — cwd now comes from session/new
	delete env.PI_ACP_TEST_SESSION_DIR; // removed — session dir now comes from session/new
	delete env.AGENT_PROFILE;
	if (agentProfile) env.AGENT_PROFILE = agentProfile;
	if (trustStore) env.PI_TRUST_STORE = trustStore;
	// When a hermetic trust store is supplied, seed it: trusted=true records an
	// explicit trust for the fixture project; trusted=false leaves it absent so
	// the headless default (untrusted) applies.
	if (trustStore) {
		writeFileSync(
			join(TRUST_DIR, "trust.json"),
			JSON.stringify(trusted ? { [FIXTURE_PROJECT]: true } : {}),
		);
	}

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
// The fixture project is trusted in the user's real trust store, so the
// project-extension path loads the fixture and the lifecycle ordering is
// exercised end to end.
{
	const { child, request, getStderr } = runAdapter({ agentProfile: "tech-lead" });
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "lifecycle-set" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: FIXTURE_PROJECT, mcpServers: [] });
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

		const created = await request("session/new", { cwd: FIXTURE_PROJECT, mcpServers: [] });
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

// ── Scenario 3: untrusted project → fixture must NOT execute ───────────────
// Hermetic trust store with NO entry for the fixture project: the headless
// default is untrusted, so the adapter must refuse to load/bind the project's
// .pi/extensions/. The fixture's session_start handler must never run, so no
// AGENT_FLAG_SEEN marker appears on stderr.
{
	const { child, request, getStderr } = runAdapter({
		agentProfile: "tech-lead",
		trusted: false,
		trustStore: TRUST_DIR,
	});
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "trust-untrusted" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: FIXTURE_PROJECT, mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");

		const seen = observedFlag(getStderr());
		const pass = seen === null; // fixture must NOT have run
		console.log(
			`③ untrusted project → fixture ${seen === null ? "did not execute" : `EXECUTED (observed "${seen}")`}: ${pass ? "PASS ✓" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
	}
}

// ── Scenario 4: explicitly trusted project → fixture must execute ──────────
// Hermetic trust store with an explicit trust entry for the fixture project:
// the adapter must load/bind the project extension, so the fixture's
// session_start handler runs and the AGENT_PROFILE flag is observed.
{
	const { child, request, getStderr } = runAdapter({
		agentProfile: "tech-lead",
		trusted: true,
		trustStore: TRUST_DIR,
	});
	try {
		const init = await request("initialize", {
			protocolVersion: 2,
			clientCapabilities: {},
			clientInfo: { name: "trust-trusted" },
		});
		assert.equal(init.error, undefined, "initialize must succeed");

		const created = await request("session/new", { cwd: FIXTURE_PROJECT, mcpServers: [] });
		assert.equal(created.error, undefined, "session/new must succeed");

		const seen = observedFlag(getStderr());
		const pass = seen === "tech-lead";
		console.log(
			`④ trusted project → fixture observed "${seen ?? "nothing"}": ${pass ? "PASS ✓" : "FAIL ✗"}`,
		);
		if (!pass) failures++;
	} finally {
		child.stdin.end();
		await new Promise((r) => child.once("exit", r));
	}
}

if (failures > 0) {
	console.error(`\n✗ ${failures} lifecycle/trust regression check(s) failed`);
	process.exit(1);
}
console.log("\n✓ lifecycle + project-trust regression: flag ordering and trust boundary hold");
process.exit(0);
