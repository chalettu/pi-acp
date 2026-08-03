# pi-acp

**English** | [中文](#中文)

A thin **ACP (Agent Client Protocol) adapter** that lets [Buzz](https://github.com/block/buzz) drive the **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent** as a managed agent — the same role `claude-agent-acp` plays for Claude Code, `codex-acp` for Codex.

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
git clone <your-fork-url> pi-acp
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

**Model picker.** The adapter surfaces pi's configured models as ACP `configOptions` so Buzz's dropdown is live. When Buzz picks one (via `session/set_config_option` with `configId="model"`), the adapter actually applies it.

**Resilience.**
- **Inactivity watchdog** — if a prompt produces no events (text / tool / retry) for 5 minutes, the model is stuck; the adapter aborts and surfaces a message.
- **Auto-retry** — transient model errors self-heal; each retry is surfaced so the UI never looks frozen.
- **Empty-turn fallback** — if the model returns nothing, a visible error is emitted instead of a blank spinner.

## License

Apache-2.0

---

<a id="中文"></a>

# 中文

一个轻量的 **ACP（Agent Client Protocol，Agent 客户端协议）适配器**，让 [Buzz](https://github.com/block/buzz) 能把 **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编程 Agent** 当作托管 Agent（managed agent）来驱动——就像 `claude-agent-acp` 包装 Claude Code、`codex-acp` 包装 Codex 一样。

```
Buzz（宿主 / 编排者）
   │  stdin · stdout · NDJSON · JSON-RPC 2.0
   ▼
pi-acp.mjs   ◄── 本适配器（纯翻译层，自身无业务逻辑）
   │  pi SDK（createAgentSession / session.prompt / subscribe）
   ▼
pi agent（你已配置的模型 + 工具 + 技能）
```

Buzz 是**宿主**：它把 Agent 作为本地子进程启动，通过 NDJSON JSON-RPC 协议线驱动它。本适配器就是 pi 的那个子进程——它把 ACP 请求翻译成 pi SDK 调用，再把 pi 的输出流作为 ACP `session/update` 通知发回去。**它不依赖 Buzz 的任何源码**——只依赖 ACP 协议线（一个标准）和 pi SDK（一个 npm 包）。

---

## 环境要求

- **Node.js** ≥ 20
- **pi** 必须已安装并配置好（`~/.pi/agent/auth.json` 里有你的模型密钥）。适配器不管密钥——它直接复用 pi 已有的配置。

## 安装

```bash
git clone <你的仓库地址> pi-acp
cd pi-acp
npm install
```

## 接入 Buzz

Buzz 从 app-data 目录里的 JSON 文件发现自定义 Agent 运行时。复制模板，指向你 clone 的目录：

```bash
# macOS
cp pi.json.template ~/Library/Application\ Support/xyz.block.buzz.app/custom_harnesses/pi.json

# 编辑这个文件——把 <PATH-TO-PI-ACP> 替换成这个仓库的真实路径：
#   "args": ["/Users/你/dev/pi-acp/pi-acp.mjs"]
```

重启 Buzz 桌面 App。**pi** 就会出现在 Agent 运行时下拉菜单里（和 Claude / Codex / Goose 并列）。创建 Agent 时选它，Buzz 就会启动本适配器。

> 对 Buzz 仓库 `git pull` 永远不会影响本项目或 `custom_harnesses/` 目录——它们都在源码树之外。

## 独立测试（不接 Buzz）

```bash
# 冒烟测试——initialize + session/new 握手
npm test

# 完整端到端测试——模拟 Buzz 驱动适配器，检查模型列表、
# systemPrompt 转发、工具调用显示
npm run test:e2e
```

也可以手动喂原始 ACP NDJSON：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2,"clientCapabilities":{},"clientInfo":{"name":"test"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<粘贴上面的sessionId>","prompt":[{"type":"text","text":"说你好"}]}}' \
  | node ./pi-acp.mjs
```

## 实现了什么

| ACP 方法 | 行为 |
|---|---|
| `initialize` | 握手；声明不支持 steering 扩展。 |
| `session/new` | 创建 pi `AgentSession`；返回 `sessionId` + `configOptions`（pi 已配置的模型，供 Buzz 选择器用）+ `models.default`。 |
| `session/prompt` | 执行 `session.prompt(text)`；流式发送 `agent_message_chunk` + `tool_call` + `tool_call_update`；返回 `stopReason`。 |
| `session/cancel` | 调用 `session.abort()`；进行中的 prompt 以 `stopReason: "cancelled"` 结束。 |
| `session/set_model` | 解析模型并调用 `session.setModel()`。 |
| `session/set_config_option` | 若 `configId="model"`，则应用该模型（一旦适配器声明了 `configOptions`，Buzz 就走这条路径设模型）。 |

## 工作原理

**System prompt 转发。** Buzz 在 `session/new` 里把它的基础 prompt + 人设作为 `systemPrompt` 发来。适配器通过 `DefaultResourceLoader({ appendSystemPrompt })` 把它追加到 pi 自己的 system prompt 后面，这样 pi 既保留全部工具文档 / 技能 / 当前目录上下文，**又**获得了 Buzz 的协作规则（@提及、回调、记忆纪律）。

**模型选择器。** 适配器把 pi 已配置的模型作为 ACP `configOptions` 暴露出来，Buzz 的下拉菜单就活了。Buzz 选一个（通过 `session/set_config_option`，`configId="model"`）后，适配器真正应用它。

**健壮性。**
- **不活动看门狗**——如果一个 prompt 连续 5 分钟没有任何事件（文本 / 工具 / 重试），说明模型卡死了；适配器自动 abort 并发出一条可见消息。
- **自动重试**——短暂的模型错误会自动恢复；每次重试都会显示，UI 不会看起来像冻结了。
- **空回复兜底**——如果模型什么都没返回，会发出一条可见错误，而不是空白转圈。

## 许可证

Apache-2.0
