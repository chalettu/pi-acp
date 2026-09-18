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
// Hermeticity: every scenario runs the adapter in a child process whose
// PI_CODING_AGENT_DIR points to a fresh OS temp directory (mkdtemp). The temp
// agent dir contains only a canonical-path trust.json we control. No model
// auth is needed — the trust/lifecycle scenarios exercise extension loading
// and flag ordering, which happen before model selection. This makes the
// trust decision fully deterministic — the test never reads or writes the
// user's real ~/.pi/agent/ state, and the four scenarios are independent of
// each other and of the machine's trust state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
// The fixture project: its .pi/extensions/ holds the fixture extension, so the
// adapter discovers it through pi's standard project-extension path. No other
// project resources are present, so the session stays hermetic.
const FIXTURE_PROJECT = resolve(here, "fixtures/project");

/**
 * Create a hermetic temp agent directory for one scenario:
 *   - trust.json with the given trust decision for FIXTURE_PROJECT
 * No auth.json is copied — the trust/lifecycle scenarios need no model, and
 * duplicating real credentials into temp storage is poor security hygiene.
 * Returns the temp dir path; the caller must rmSync it in a finally block.
 */
function createHermeticAgentDir(trusted) {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-test-"));
	mkdirSync(dir, { recursive: true });
	// Canonical-path trust.json: the SDK's ProjectTrustStore normalizes cwd
	// via canonicalizePath(resolvePath(cwd)), so the key must match the
	// canonicalized fixture path.
	const trustData = trusted ? { [FIXTURE_PROJECT]: true } : {};
	writeFileSync(join(dir, "trust.json"), JSON.stringify(trustData, null, 2) + "\n");
	return dir;
}

function runAdapter({ agentProfile, trusted = false }) {
	const tempAgentDir = createHermeticAgentDir(trusted);
	const env = { ...process.env };
	delete env.PI_ACP_TEST_CWD;
	delete env.PI_ACP_TEST_SESSION_DIR;
	delete env.PI_TRUST_STORE;
	delete env.AGENT_PROFILE;
	if (agentProfile) env.AGENT_PROFILE = agentProfile;
	// PI_CODING_AGENT_DIR is the SDK-supported override for the agent
	// directory (config.js: getAgentDir() reads it). Pointing it at the
	// hermetic temp dir makes the trust store, settings, and session dir
	// all live under the temp path — fully isolated from the user's real
	// ~/.pi/agent/.
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

	return { child, request, getStderr: () => stderr, tempAgentDir };
}

function observedFlag(stderr) {
	const match = stderr.match(/AGENT_FLAG_SEEN=([^\n]*)/);
	return match ? match[1] : null;
}

let failures = 0;

// ── Scenario 1: AGENT_PROFILE set → fixture sees the value ─────────────────
// Hermetic agent dir with an explicit trust entry for the fixture project:
// the project-extension path loads the fixture and the lifecycle ordering is
// exercised end to end.
{
	const { child, request, getStderr, tempAgentDir } = runAdapter({ agentProfile: "tech-lead", trusted: true });
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
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
}

// ── Scenario 2: AGENT_PROFILE unset → fixture sees (none) ──────────────────
// Same hermetic setup, but no AGENT_PROFILE env: the fixture must observe
// (none) — no profile applied.
{
	const { child, request, getStderr, tempAgentDir } = runAdapter({ agentProfile: undefined, trusted: true });
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
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
}

// ── Scenario 3: untrusted project → fixture must NOT execute ───────────────
// Hermetic trust store with NO entry for the fixture project: the headless
// default is untrusted, so the adapter must refuse to load/bind the project's
// .pi/extensions/. The fixture's session_start handler must never run, so no
// AGENT_FLAG_SEEN marker appears on stderr.
{
	const { child, request, getStderr, tempAgentDir } = runAdapter({
		agentProfile: "tech-lead",
		trusted: false,
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
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
}

// ── Scenario 4: explicitly trusted project → fixture must execute ──────────
// Hermetic trust store with an explicit trust entry for the fixture project:
// the adapter must load/bind the project extension, so the fixture's
// session_start handler runs and the AGENT_PROFILE flag is observed.
{
	const { child, request, getStderr, tempAgentDir } = runAdapter({
		agentProfile: "tech-lead",
		trusted: true,
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
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
}

if (failures > 0) {
	console.error(`\n✗ ${failures} lifecycle/trust regression check(s) failed`);
	process.exit(1);
}
console.log("\n✓ lifecycle + project-trust regression: flag ordering and trust boundary hold");
process.exit(0);
