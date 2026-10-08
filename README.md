# pi-acp

**English** | [中文](README.zh-CN.md)

> A battle-tested **ACP adapter** that lets [Buzz](https://buzz.xyz/) drive the
> **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent**
> as a managed agent — **zero Buzz source changes, drop-in via custom harness.**

```
Buzz (host / harness)
   │  stdin · stdout · NDJSON · JSON-RPC 2.0
   ▼
pi-acp.mjs   ◄── this adapter
   │  pi SDK
   ▼
pi agent (your models + tools + skills)
```

---

## Why this one?

There are a few `pi-acp` implementations floating around. Most are thin proxies
that handle the handshake and call it a day. This one was **debugged through
nine iterations against a live Buzz relay** and solves the problems that make a
naive adapter silently fail:

| Problem a naive adapter hits | What this one does |
|---|---|
| **Agent hangs on first prompt** — Buzz switches from `set_model` to `set_config_option` once you advertise `configOptions`; if you only ACK without applying, the session stays on a broken default model and every prompt deadlocks. | Actually resolves and applies the model on `set_config_option`. |
| **Buzz's persona / collaboration rules never reach pi** — the `systemPrompt` from `session/new` is silently dropped. | Appends it to pi's own system prompt via `appendSystemPrompt`, so pi keeps its tools/skills **and** gains @mention, callback, and memory rules. |
| **Tool activity invisible** — pi emits tool calls as nested `toolcall_end` events, not top-level; a naive adapter never surfaces them. | Emits `tool_call` + `tool_call_update` with status transitions; the UI shows what the agent is doing. |
| **Reasoning / thinking swallowed** — chain-of-thought deltas are dropped. | Streams them as `agent_thought_chunk` so the "Thinking" panel renders. |
| **Model error = silent freeze** — the UI spins forever on a dead provider. | Auto-retry (each attempt surfaced) + 5-min inactivity watchdog + empty-turn fallback. |

## Requirements

- **Node.js** ≥ 20
- **pi** installed and configured (`~/.pi/agent/auth.json` with your model keys).
  The adapter reuses your existing pi config — no separate key setup.

## Quick start

```bash
git clone https://github.com/patrick-xin/pi-acp.git
cd pi-acp && npm install
```

Register it as a Buzz custom harness (no source changes):

```bash
cp pi.json.template ~/Library/Application\ Support/xyz.block.buzz.app/custom_harnesses/pi.json
# Edit pi.json — replace <PATH-TO-PI-ACP> with the real clone path
```

Restart Buzz → **pi** appears in the agent runtime dropdown alongside Claude / Codex / Goose.

> ** Buzz `git pull` never touches this project** — it lives entirely outside
> the source tree, as a custom harness + a standalone repo.

## Test standalone

```bash
npm test           # smoke: initialize + session/new
npm run test:e2e   # full: model list, systemPrompt forwarding, tool surfacing
```

## What's implemented

| ACP method | Behavior |
|---|---|
| `initialize` | Handshake with pi identity/capabilities; advertises no steering or MCP transport. |
| `session/new` | Creates a pi session; returns selected model + model catalog in both ACP config/state shapes, plus Pi's thinking-level config. |
| `session/prompt` | Runs the prompt; streams `agent_message_chunk` + `agent_thought_chunk` + `tool_call` + `tool_call_update`; returns `stopReason`. |
| `session/cancel` | `session.abort()`; resolves `stopReason: "cancelled"`. |
| `session/set_model` | Resolves and applies the model. |
| `session/set_config_option` | Applies `model` and `thinking`/`effort` options. |

### MCP status

Since SDK 1.0.4 the adapter registers Pi's built-in MCP client (and the `codemode`
tool) via the resource loader's `extensionFactories`. MCP servers configured in the
user's pi settings (`~/.pi/agent/mcp.json`) connect at session start and their tools
are reachable through codemode (default exposure). The adapter still advertises no
ACP MCP transport and logs — rather than forwards — any `mcpServers` supplied in
`session/new`; it does **not** claim host-supplied servers are available to the
model. Bridging host-supplied servers is separate work.

The `codemode` tool registers **inactive**; it activates for a session only when the
settings `defaultTools` includes `+codemode` (or the host passes `--tools`). The
adapter logs `session.getActiveToolNames()` after binding as the activation
diagnostic.

Persona tool filtering (the `AGENT_PROFILE` flag read by pi-open-agents during
`session_start`) restricts **builtin** tools only: a persona `tools:` whitelist
trims builtins to the named set, while non-builtin tools — inline SDK extensions
like `codemode`, user extensions, and MCP tools — are kept unconditionally. A
persona therefore cannot deactivate `codemode`; excluding a non-builtin tool
requires the SDK's `allowedToolNames` gate (`createAgentSession` `tools` /
`noTools`), not the persona file. The reverse is also true and is the operative
least-privilege boundary: pi-open-agents calls `setActiveTools(...)` during
`session_start`, so a restrictive persona (or even a persona with **no** `tools:`
field, which activates ALL registered tools) re-activates `codemode` for the
session **even when the settings never enabled `+codemode`** — the persona file
cannot keep a globally-disabled tool disabled. `test/codemode.mjs` proves both
directions against a fixture mirroring the pi-open-agents filter (scenarios ③/④)
and against the **real pinned pi-open-agents 0.1.22** package (R1–R6, exact
active-set assertions through the SDK package manager).

## Architecture

This is a **generic ACP adapter**, not a Buzz plugin. It speaks the standard
[Agent Client Protocol](https://github.com/agentclientprotocol) over NDJSON
stdio — the same protocol `@agentclientprotocol/claude-agent-acp` and
`@agentclientprotocol/codex-acp` use. Any ACP-compliant host (Buzz, Zed, etc.)
can drive it. **Zero dependency on Buzz source code** — only the ACP wire
spec and the pi SDK.

## License

[MIT](LICENSE)
