/**
 * Repo-local fixture extension for the AGENT_PROFILE lifecycle regression.
 *
 * It mirrors the ONE behavior of pi-open-agents that the adapter must get right:
 * register a string "agent" flag at load time, then read it back during
 * session_start. pi-open-agents does exactly this — it registers the flag at
 * the top of its entry point and only calls pi.getFlag("agent") inside its
 * session_start handler. Because the SDK's bindExtensions() fires session_start
 * on its LAST step, the flag value is only visible to session_start if the
 * adapter set it BEFORE calling bindExtensions().
 *
 * The fixture reports the observed value on stderr so the regression test can
 * assert on it without depending on the globally installed pi-open-agents
 * package (which would make the test environment-specific and non-portable).
 *
 * Discovered through pi's normal project-extension path: test/lifecycle.mjs
 * points the adapter's session cwd at this file's grandparent directory
 * (test/fixtures/project, via the PI_ACP_TEST_CWD env var), and pi auto-loads
 * anything under <cwd>/.pi/extensions/. No special loader hook is needed.
 */
export default async function agentFlagFixture(pi) {
	// Register the flag immediately, before session_start — same as pi-open-agents.
	pi.registerFlag("agent", {
		description: "fixture: agent requested via AGENT_PROFILE",
		type: "string",
	});

	pi.on("session_start", (event) => {
		const value = pi.getFlag("agent");
		// Event markers are greppable by the regression test.
		if (typeof value === "string" && value) {
			process.stderr.write(`[fixture] AGENT_FLAG_SEEN=${value}\n`);
		} else {
			process.stderr.write(`[fixture] AGENT_FLAG_SEEN=(none)\n`);
		}
	});
}
