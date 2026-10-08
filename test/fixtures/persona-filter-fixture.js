/**
 * Repo-local fixture mirroring the TOOL-FILTERING behavior of pi-open-agents
 * 0.1.22 (src/primary/executor.ts applyTools) for hermetic persona-filtering
 * regression scenarios.
 *
 * It mirrors the ONE behavior the persona gate must get right:
 *   1. Register a string "agent" CLI flag at load time (pi-open-agents does
 *      this; the pi-acp adapter sets its value from AGENT_PROFILE before
 *      bindExtensions — the agent-profile lifecycle branch covers that order).
 *   2. On session_start, read the flag, load <agentDir>/agents/<profile>.md,
 *      and parse its `tools:` CSV frontmatter (pi-style whitelist).
 *   3. Apply the filter EXACTLY as pi-open-agents does:
 *        - builtin-sourced tools (sourceInfo.source === "builtin") are kept
 *          only if named in the whitelist;
 *        - ALL non-builtin tools (extensions, inline SDK extensions such as
 *          codemode, MCP) are kept unconditionally.
 *      via pi.setActiveTools(...).
 *
 * It deliberately does NOT mirror the model/thinking/prompt parts of
 * pi-open-agents (out of scope for this regression) and reports the result
 * on stderr so the test can assert on it without depending on the real
 * npm:pi-open-agents package (which would make the test environment-specific).
 *
 * Discovered through pi's normal user-extension path: the test copies this
 * file into <hermetic agent dir>/extensions/, where pi auto-loads it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = dirname(dirname(fileURLToPath(import.meta.url)));

export default async function personaFilterFixture(pi) {
	// Same registration point as pi-open-agents (must be at load time).
	pi.registerFlag("agent", {
		description: "fixture: persona profile from AGENT_PROFILE",
		type: "string",
	});

	pi.on("session_start", () => {
		const profile = pi.getFlag("agent");
		if (typeof profile !== "string" || !profile) {
			process.stderr.write("[persona-fixture] no AGENT_PROFILE — no filtering\n");
			return;
		}

		let whitelist;
		try {
			const text = readFileSync(join(agentDir, "agents", `${profile}.md`), "utf8");
			const match = text.match(/^tools:\s*(.+)$/m);
			const names = (match ? match[1] : "")
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			whitelist = new Set(names);
		} catch {
			process.stderr.write(`[persona-fixture] agents/${profile}.md missing — no filtering\n`);
			return;
		}

		process.stderr.write(
			`[persona-fixture] profile=${profile} whitelist=${[...whitelist].join(",") || "(none)"}\n`,
		);
		if (whitelist.size === 0) return; // no restriction — keep all tools

		const all = pi.getAllTools();
		const filtered = all
			.filter((t) => {
				// Always keep non-builtin tools (extensions, inline, MCP).
				if (t.sourceInfo?.source !== "builtin") return true;
				return whitelist.has(t.name.toLowerCase());
			})
			.map((t) => t.name);
		pi.setActiveTools(filtered);
		process.stderr.write(`[persona-fixture] active after filter=${filtered.join(",")}\n`);
	});
}
