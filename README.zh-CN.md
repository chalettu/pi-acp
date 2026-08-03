# pi-acp

[English](README.md) | **中文**

一个轻量的 **ACP（Agent Client Protocol，Agent 客户端协议）适配器**，让 [Buzz](https://buzz.xyz/) 能把 **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编程 Agent** 当作托管 Agent（managed agent）来驱动——就像 `claude-agent-acp` 包装 Claude Code、`codex-acp` 包装 Codex 一样。

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
git clone https://github.com/patrick-xin/pi-acp.git
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

**模型选择器。** 适配器把 pi 已配置的模型作为 ACP `configOptions` 暴露出来，Buzz 的下拉菜单就活了。Buzz 选一个（通过 `session/set_config_option`，`configId="model"`）后，适配器真正应用它。如果 pi 的默认模型没有配置认证，适配器会在任何 prompt 之前自动切到第一个可用模型。

**健壮性。**
- **不活动看门狗**——如果一个 prompt 连续 5 分钟没有任何事件（文本 / 工具 / 重试），说明模型卡死了；适配器自动 abort 并发出一条可见消息。
- **自动重试**——短暂的模型错误会自动恢复；每次重试都会显示，UI 不会看起来像冻结了。
- **空回复兜底**——如果模型什么都没返回，会发出一条可见错误，而不是空白转圈。

## 许可证

[MIT](LICENSE)
