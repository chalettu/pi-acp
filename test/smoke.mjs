import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";

// Explicitly clear AGENT_PROFILE so an inherited managed-agent env (e.g. when a
// developer runs the suite from a profile-routed session) cannot contaminate the
// baseline. The baseline must reflect the configured default, not a profile.
const smokeEnv = { ...process.env };
delete smokeEnv.AGENT_PROFILE;

const child = spawn("node", ["pi-acp.mjs"], {
	stdio: ["pipe", "pipe", "inherit"],
	env: smokeEnv,
});
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
	const message = JSON.parse(line);
	const resolve = pending.get(message.id);
	if (resolve) {
		pending.delete(message.id);
		resolve(message);
	}
});

function request(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`timed out waiting for ${method}`));
		}, 15_000);
		pending.set(id, (message) => {
			clearTimeout(timeout);
			resolve(message);
		});
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
}

try {
	const initialized = await request("initialize", {
		protocolVersion: 2,
		clientCapabilities: {},
		clientInfo: { name: "smoke" },
	});
	assert.equal(initialized.error, undefined);
	assert.equal(initialized.result.protocolVersion, 2);
	assert.equal(initialized.result.agentInfo.name, "pi");
	assert.equal(typeof initialized.result.agentInfo.version, "string");
	assert.deepEqual(initialized.result.agentCapabilities.mcpCapabilities, {
		http: false,
		sse: false,
	});

	const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
	assert.equal(created.error, undefined);
	assert.equal(typeof created.result.sessionId, "string");

	const modelOption = created.result.configOptions.find(
		(option) => option.category === "model",
	);
	assert.ok(modelOption, "session/new must expose a model config option");
	assert.equal(modelOption.configId, "model");
	assert.equal(modelOption.currentValue, modelOption.value);
	assert.equal(
		created.result.models.currentModelId,
		modelOption.currentValue,
		"the stable config option and unstable model state must agree",
	);
	assert.ok(
		modelOption.options.every(
			(option) => typeof option.value === "string" && typeof option.displayName === "string",
		),
		"model options must use ACP displayName fields",
	);

	const thinkingOption = created.result.configOptions.find(
		(option) => option.category === "effort",
	);
	assert.ok(thinkingOption, "session/new must expose Pi thinking level");
	assert.equal(thinkingOption.configId, "thinking");
	assert.equal(thinkingOption.currentValue, thinkingOption.value);
	assert.ok(thinkingOption.options.some((option) => option.value === "medium"));

	if (modelOption.options.length > 0) {
		const model = await request("session/set_config_option", {
			sessionId: created.result.sessionId,
			configId: "model",
			value: modelOption.options[0].value,
		});
		assert.equal(model.error, undefined);
	}

	const effort = await request("session/set_config_option", {
		sessionId: created.result.sessionId,
		configId: "thinking",
		value: "medium",
	});
	assert.equal(effort.error, undefined);

	const invalidEffort = await request("session/set_config_option", {
		sessionId: created.result.sessionId,
		configId: "thinking",
		value: "not-a-level",
	});
	assert.equal(invalidEffort.error.code, -32602);

	console.log(
		`✓ initialize + session/new: ${created.result.sessionId.slice(0, 8)} models: ${modelOption.options.length}`,
	);
} finally {
	child.stdin.end();
	await new Promise((resolve) => child.once("exit", resolve));
}
