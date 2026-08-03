# pi-acp

**English** | [中文](README.zh-CN.md)

A thin **ACP (Agent Client Protocol) adapter** that lets [Buzz](https://buzz.xyz/) drive the **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent** as a managed agent — the same role `claude-agent-acp` plays for Claude Code, `codex-acp` for Codex.

```
Buzz (host / harness)
   │  stdin · stdout · NDJSON · JSON-RPC 2.0
   ▼
pi-acp.mjs   ◄── this adapter (pure translation, no logic of its own)
   │  pi SDK (createAgentSession / session.prompt / subscribe)
   ▼
pi agent (your configured model + tools + skills)
```

Buzz is a **host**: it spawns an agent as a local subprocess and drives it over an NDJSON JSON-RPC wire. This adapter is that subprocess for pi — it translates ACP requests into pi SDK calls and streams pi's output back as ACP `session/update` notifications. **It depends on zero lines of Buzz source code** — only the ACP wire protocol (a standard) and the pi SDK (an npm package).

---

## Requirements

- **Node.js** ≥ 20
- **pi** must be installed and configured (`~/.pi/agent/auth.json` with your model keys). The adapter does not manage keys — it reuses whatever pi already has.

## Install

```bash
git clone https://github.com/patrick-xin/pi-acp.git
cd pi-acp
npm install
```

## Wire it into Buzz

Buzz discovers custom agent runtimes from JSON files in its app-data folder. Copy the template and point it at your clone:

```bash
# macOS
cp pi.json.template ~/Library/Application\ Support/xyz.block.buzz.app/custom_harnesses/pi.json

# Edit the file — replace <PATH-TO-PI-ACP> with the real path to this repo:
#   "args": ["/Users/you/dev/pi-acp/pi-acp.mjs"]
```

Restart the Buzz desktop app. **pi** now appears as an agent runtime alongside Claude / Codex / Goose. Pick it when creating an agent — Buzz will spawn this adapter.

> `git pull` on the Buzz repo never touches this project or the `custom_harnesses/` folder — both live outside the source tree.

## Test standalone (without Buzz)

```bash
# Smoke test — initialize + session/new handshake
npm test

# Full E2E — drives the adapter like Buzz does, checks model list,
# systemPrompt forwarding, and tool-call surfacing
npm run test:e2e
```

Or feed it raw ACP NDJSON manually:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2,"clientCapabilities":{},"clientInfo":{"name":"test"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<paste-sessionId-here>","prompt":[{"type":"text","text":"say hi"}]}}' \
  | node ./pi-acp.mjs
```

## What's implemented

| ACP method | Behavior |
|---|---|
| `initialize` | Handshake; advertises no steering extension. |
| `session/new` | Creates a pi `AgentSession`; returns `sessionId` + `configOptions` (pi's authed models, for Buzz's picker) + `models.default`. |
| `session/prompt` | Runs `session.prompt(text)`; streams `agent_message_chunk` + `tool_call` + `tool_call_update`; returns `stopReason`. |
| `session/cancel` | `session.abort()`; in-flight prompt resolves `stopReason: "cancelled"`. |
| `session/set_model` | Resolves the model and calls `session.setModel()`. |
| `session/set_config_option` | If `configId="model"`, applies the model (this is the path Buzz uses once `configOptions` are advertised). |

## How it works

**System prompt forwarding.** Buzz sends its base prompt + persona as `systemPrompt` in `session/new`. The adapter appends it to pi's own system prompt via `DefaultResourceLoader({ appendSystemPrompt })`, so pi keeps all its tool docs / skills / cwd context **and** gains Buzz's collaboration rules (@mention, callback, memory discipline).

**Model picker.** The adapter surfaces pi's configured models as ACP `configOptions` so Buzz's dropdown is live. When Buzz picks one (via `session/set_config_option` with `configId="model"`), the adapter actually applies it. If pi's default model lacks configured auth, the adapter auto-switches to the first available one before any prompt runs.

**Resilience.**
- **Inactivity watchdog** — if a prompt produces no events (text / tool / retry) for 5 minutes, the model is stuck; the adapter aborts and surfaces a message.
- **Auto-retry** — transient model errors self-heal; each retry is surfaced so the UI never looks frozen.
- **Empty-turn fallback** — if the model returns nothing, a visible error is emitted instead of a blank spinner.

## License

[MIT](LICENSE)
