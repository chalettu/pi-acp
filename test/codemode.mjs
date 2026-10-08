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
//   5. R1–R6 run the REAL pinned pi-open-agents 0.1.22 package through the
//      SDK package manager, with NO mirror fixture copied (its absence is
//      asserted, as is the absence of its [persona-fixture] diagnostics), so
//      each asserted exact active set is produced by the real package's
//      applyTools alone. The exact set is re-verified after a lifecycle
//      refresh: the adapter's /reset disposes and re-creates the pi session,
//      whose session_start re-runs the package's applyTools (the
//      before_agent_start refresh is the same function but needs a live
//      model prompt — /reset is the hermetic vehicle).
//
// Transport contract (asserted in EVERY scenario): stdout is reserved for
// protocol NDJSON — the adapter takes over the SDK output-guard, so package
// install output routes to stderr. Every stdout line must parse as JSON; a
// non-JSON line is a recorded transport violation that fails the scenario.
// A conforming reader's silent skip of unparseable lines would hide exactly
// the cold-install leak this pins (fresh agent dir → real npm install during
// session/new).
//
// Hermeticity mirrors test/lifecycle.mjs: every scenario gets a fresh
// mkdtemp agent dir and a plain temp project cwd; the test never touches the
// user's real ~/.pi/agent/ state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

function createHermeticAgentDir(defaultTools, personaProfile = null, realPackage = false) {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-codemode-"));
	mkdirSync(dir, { recursive: true });
	const settings = { defaultTools };
	if (realPackage) {
		// The REAL live persona mechanism: pinned pi-open-agents. The SDK's
		// package manager installs it into <agentDir>/npm (hermetic temp dir —
		// the user's real agent dir is never touched) and its extension runs
		// the real applyTools policy path in session_start.
		settings.packages = ["npm:pi-open-agents@0.1.22"];
	}
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	if (personaProfile && !realPackage) {
		// Mirror-fixture scenarios (③/④) ONLY. Real-package scenarios install
		// the ACTUAL pi-open-agents package, so a copied mirror must NOT be
		// present — a second filter running alongside the real one would let
		// the asserted active set be produced by either mechanism, which is
		// not the isolation the R scenarios claim.
		mkdirSync(join(dir, "extensions"), { recursive: true });
		copyFileSync(
			join(here, "fixtures", "persona-filter-fixture.js"),
			join(dir, "extensions", "persona-filter-fixture.js"),
		);
	}
	if (personaProfile || realPackage) {
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(
			join(dir, "agents", "persona-permit.md"),
			"---\nname: persona-permit\ntools: read, bash, codemode\n---\n\npermitting persona\n",
		);
		writeFileSync(
			join(dir, "agents", "persona-strict.md"),
			"---\nname: persona-strict\ntools: read\n---\n\nstrict persona\n",
		);
		writeFileSync(
			join(dir, "agents", "persona-open.md"),
			"---\nname: persona-open\n---\n\nopen persona (no tools field)\n",
		);
	}
	return dir;
}

function runAdapter({ defaultTools, agentProfile = null, realPackage = false }) {
	const tempAgentDir = createHermeticAgentDir(defaultTools, agentProfile, realPackage);
	const tempProject = mkdtempSync(join(tmpdir(), "pi-acp-codemode-proj-"));
	const env = { ...process.env };
	delete env.PI_ACP_TEST_CWD;
	delete env.PI_ACP_TEST_SESSION_DIR;
	delete env.PI_TRUST_STORE;
	// When run under `npm test`, the child would inherit the outer npm's
	// lifecycle/config env (npm_config_*, npm_lifecycle_*); strip it so the
	// inner `npm install` (real-package scenarios) behaves identically to a
	// bare launch.
	for (const key of Object.keys(env)) {
		if (key.startsWith("npm_") || key.startsWith("NPM_") || key === "INIT_CWD") delete env[key];
	}
	if (agentProfile === null) {
		delete env.AGENT_PROFILE;
	} else {
		env.AGENT_PROFILE = agentProfile;
	}
	env.PI_CODING_AGENT_DIR = tempAgentDir;
	if (realPackage) {
		// Prefer the local npm cache so the pinned install stays hermetic.
		env.npm_config_prefer_offline = "true";
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
	// The adapter contract reserves stdout for protocol NDJSON (pi-acp.mjs
	// takes over the SDK output-guard, so package-install output routes to
	// stderr). Any non-JSON line is a transport defect — record it and let
	// the scenario fail loudly; NEVER silently skip (a conforming reader's
	// skip is exactly what masked the cold-install leak).
	const stdoutViolations = [];

	rl.on("line", (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			stdoutViolations.push(line.slice(0, 200));
			return;
		}
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

	return {
		child,
		request,
		getStderr: () => stderr,
		getStdoutViolations: () => stdoutViolations,
		tempAgentDir,
		tempProject,
	};
}

function activeToolsLine(stderr) {
	const match = stderr.split("\n").find((l) => l.includes("active tools:"));
	return match ? match.split("active tools:")[1].trim() : null;
}

function activeToolNames(stderr) {
	const line = activeToolsLine(stderr);
	return line ? line.split(/,\s*/).filter(Boolean) : [];
}

// The LAST "active tools:" line — used after the /reset lifecycle refresh,
// which re-logs it for the re-created session.
function lastActiveToolNames(stderr) {
	const lines = stderr.split("\n").filter((l) => l.includes("active tools:"));
	const line = lines[lines.length - 1];
	return line ? line.split("active tools:")[1].trim().split(/,\s*/).filter(Boolean) : null;
}

let failures = 0;

// ── Scenario 1: defaultTools "+codemode" → active ─────────────────────────
{
	const { child, request, getStderr, getStdoutViolations, tempAgentDir, tempProject } = runAdapter({
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
		const pass = active !== null && /(^|[,\s])codemode([,\s]|$)/.test(active) && getStdoutViolations().length === 0;
		console.log(
			`① defaultTools [+codemode] → active tools: "${active ?? "(missing)"}": ${pass ? "PASS ✓" : `FAIL ✗ (stdout violations: ${getStdoutViolations().length})`}`,
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
	const { child, request, getStderr, getStdoutViolations, tempAgentDir, tempProject } = runAdapter({
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
		const pass = readActive && codemodeInactive && getStdoutViolations().length === 0;
		console.log(
			`② defaultTools [read] → active tools: "${active ?? "(missing)"}": ${pass ? "PASS ✓ (read active, codemode correctly inactive)" : `FAIL ✗ (stdout violations: ${getStdoutViolations().length})`}`,
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
	const { child, request, getStderr, getStdoutViolations, tempAgentDir, tempProject } = runAdapter({
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
		const wireClean = getStdoutViolations().length === 0;
		const pass = filterRan && readActive && bashActive && codemodeActive && builtinTrimmed && wireClean;
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
	const { child, request, getStderr, getStdoutViolations, tempAgentDir, tempProject } = runAdapter({
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
		const wireClean = getStdoutViolations().length === 0;
		const pass = filterRan && readActive && builtinTrimmed && codemodeKept && wireClean;
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

// ── Real-package integration (pinned pi-open-agents 0.1.22) ─────────────
// Scenarios ①-④ above use the copied mirror fixture (fast characterization;
// an upstream filter change cannot fail them). This section runs the actual
// live persona package through the SDK package manager, so upstream changes
// DO fail it. Isolation is asserted, not assumed: the mirror fixture must be
// ABSENT from the agent dir and its [persona-fixture] diagnostics must not
// appear, so the real package's applyTools alone produced each asserted set.
//
// Exact active-set assertions (bind AND lifecycle refresh):
//
//   settings [read] × persona-strict → the real filter's setActiveTools
//   RE-ACTIVATES codemode even though the settings never enabled +codemode;
//   builtins are trimmed to {read}.
//   settings [read] × persona-open   → ALL builtins re-activated (the no-tools
//   case calls setActiveTools(ALL)), including powershell.
//   settings [read] × no profile     → control: codemode stays inactive; the
//   package's own tools (set_agent/search_agents/subagent) are the only
//   additions to the baseline.
//
// A persona file alone can therefore activate a globally-disabled tool. The
// assertions pin the observed (real) behavior so any change to the package
// or SDK filter semantics fails loudly here.
//
// Lifecycle refresh vehicle: the adapter's /reset disposes and re-creates the
// pi session (same ACP id) → full re-bind → the package's session_start
// handler re-runs applyTools — the same function the package's
// before_agent_start refresh calls, but reachable without a live model prompt
// (the refresh hook fires on a real prompt, which a hermetic dir cannot
// authenticate). The exact set is asserted again from the re-logged
// "active tools:" diagnostic.
//
// Transport: every scenario also asserts ZERO non-JSON stdout lines — the
// cold-install regression (fresh agent dir forces a real `npm install` during
// session/new) must not leak onto the protocol wire.
{
	const realPackageScenarios = [
		{
			label: "R1 settings [+codemode] × persona-permit",
			defaultTools: ["+codemode"],
			agentProfile: "persona-permit",
			expected: ["bash", "codemode", "read", "search_agents", "set_agent", "subagent"],
		},
		{
			label: "R2 settings [+codemode] × persona-strict",
			defaultTools: ["+codemode"],
			agentProfile: "persona-strict",
			expected: ["codemode", "read", "search_agents", "set_agent", "subagent"],
		},
		{
			label: "R3 settings [read] × persona-permit (no +codemode in settings)",
			defaultTools: ["read"],
			agentProfile: "persona-permit",
			expected: ["bash", "codemode", "read", "search_agents", "set_agent", "subagent"],
		},
		{
			label: "R4 settings [read] × persona-strict (no +codemode in settings)",
			defaultTools: ["read"],
			agentProfile: "persona-strict",
			expected: ["codemode", "read", "search_agents", "set_agent", "subagent"],
		},
		{
			label: "R5 settings [read] × persona-open (no tools field → setActiveTools(ALL))",
			defaultTools: ["read"],
			agentProfile: "persona-open",
			expected: [
				"bash",
				"codemode",
				"edit",
				"find",
				"grep",
				"ls",
				"powershell",
				"read",
				"search_agents",
				"set_agent",
				"subagent",
				"write",
			],
		},
		{
			label: "R6 settings [read] × no profile (control: real package present)",
			defaultTools: ["read"],
			agentProfile: null,
			expected: ["read", "search_agents", "set_agent", "subagent"],
		},
	];
	for (const scenario of realPackageScenarios) {
		const { child, request, getStderr, getStdoutViolations, tempAgentDir, tempProject } = runAdapter({
			defaultTools: scenario.defaultTools,
			agentProfile: scenario.agentProfile,
			realPackage: true,
		});
		try {
			const init = await request("initialize", {
				protocolVersion: 2,
				clientCapabilities: {},
				clientInfo: { name: "real-package" },
			});
			assert.equal(init.error, undefined, "initialize must succeed");
			const created = await request("session/new", { cwd: tempProject, mcpServers: [] });
			assert.equal(created.error, undefined, "session/new must succeed");

			const names = activeToolNames(getStderr());
			const actual = [...names].sort();
			const expected = [...scenario.expected].sort();
			let installedVersion = null;
			try {
				const pkg = JSON.parse(
					readFileSync(
						join(tempAgentDir, "npm", "node_modules", "pi-open-agents", "package.json"),
						"utf8",
					),
				);
				installedVersion = pkg.version;
			} catch {
				/* asserted below */
			}
			const packageLoaded =
				installedVersion === "0.1.22" &&
				names.includes("set_agent") &&
				names.includes("search_agents") &&
				names.includes("subagent");
			const bindMatches = JSON.stringify(actual) === JSON.stringify(expected);
			// Isolation: the mirror fixture must not be part of a real-package
			// scenario — the real package's applyTools alone produced the set.
			const fixtureAbsent =
				!existsSync(join(tempAgentDir, "extensions", "persona-filter-fixture.js"));
			const noFixtureDiagnostics = !getStderr().includes("[persona-fixture]");
			// Transport: cold-install regression — every stdout line is protocol
			// JSON (install diagnostics routed to stderr via the output guard).
			const wireClean = getStdoutViolations().length === 0;
			// Lifecycle refresh: /reset re-binds the session → session_start →
			// the real applyTools re-runs; assert the exact set again from the
			// re-logged diagnostic.
			const reset = await request("session/prompt", {
				sessionId: created.result.sessionId,
				prompt: [{ type: "text", text: "/reset" }],
			});
			const resetOk = !reset.error && reset.result?.stopReason === "end_turn";
			// stderr is a separate pipe from stdout — settle until the
			// post-reset "active tools:" line is actually captured.
			const waitStart = Date.now();
			let refreshSeen = false;
			while (Date.now() - waitStart < 5000) {
				refreshSeen =
					getStderr().split("\n").filter((l) => l.includes("active tools:")).length >= 2;
				if (refreshSeen) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			const refreshed = lastActiveToolNames(getStderr()) ?? [];
			const refreshMatches = JSON.stringify([...refreshed].sort()) === JSON.stringify(expected);
			const pass =
				packageLoaded &&
				bindMatches &&
				fixtureAbsent &&
				noFixtureDiagnostics &&
				wireClean &&
				resetOk &&
				refreshSeen &&
				refreshMatches;
			const failReason = !packageLoaded
				? `package ${installedVersion ?? "not installed"} not loaded`
				: !bindMatches
					? `bind set "${actual.join(", ")}" ≠ expected "${expected.join(", ")}"`
					: !fixtureAbsent || !noFixtureDiagnostics
						? "mirror fixture present in real-package scenario"
					: !wireClean
						? `${getStdoutViolations().length} non-JSON stdout line(s), first: "${getStdoutViolations()[0]}"`
					: !resetOk
						? `/reset failed: ${reset.error?.message ?? "unexpected result"}`
						: !refreshSeen || !refreshMatches
							? `post-refresh set "${refreshed.join(", ")}" ≠ expected "${expected.join(", ")}"`
						: "";
			console.log(
				`${scenario.label} → active: "${names.join(", ")}" (post-refresh: "${refreshed.join(", ")}"): ${pass ? "PASS ✓" : `FAIL ✗ (${failReason})`}`,
			);
			if (!pass) failures++;
		} finally {
			child.stdin.end();
			await new Promise((r) => child.once("exit", r));
			rmSync(tempAgentDir, { recursive: true, force: true });
			rmSync(tempProject, { recursive: true, force: true });
		}
	}
}

if (failures > 0) {
	console.error(`${failures} codemode regression scenario(s) FAILED`);
	process.exit(1);
}
console.log("codemode regression: all scenarios passed");
