# pi-acp

[English](README.md) | **中文**

> 一个经过实战调试的 **ACP 适配器**，让 [Buzz](https://buzz.xyz/) 能把
> **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编程 Agent**
> 当作托管 Agent 来驱动——**不改 Buzz 源码，custom harness 直接接入。**

```
Buzz（宿主 / 编排者）
   │  stdin · stdout · NDJSON · JSON-RPC 2.0
   ▼
pi-acp.mjs   ◄── 本适配器
   │  pi SDK
   ▼
pi agent（你的模型 + 工具 + 技能）
```

---

## 为什么用这个？

市面上有好几个 `pi-acp` 实现。大部分是薄薄的代理，握个手就完事了。这个是
**在真实 Buzz relay 上调试了九轮迭代**才跑通的，解决了一堆让天真适配器
静默失败的问题：

| 天真适配器会踩的坑 | 这个适配器怎么解决 |
|---|---|
| **第一次 prompt 就卡死**——你一旦声明了 `configOptions`，Buzz 就从 `set_model` 切到 `set_config_option`；如果你只 ACK 不真正应用，session 留在坏掉的默认模型上，每个 prompt 死锁。 | `set_config_option` 真正解析并应用模型。 |
| **Buzz 的人设 / 协作规则根本没到 pi**——`session/new` 里的 `systemPrompt` 被静默丢弃。 | 通过 `appendSystemPrompt` 追加到 pi 自己的 system prompt，pi 保留工具/技能，**同时**获得 @提及、回调、记忆规则。 |
| **工具调用看不见**——pi 把 tool call 作为嵌套的 `toolcall_end` 事件发，不是顶层事件；天真适配器根本不转发。 | 发出 `tool_call` + `tool_call_update`（带状态转换），UI 上能看到 agent 在干什么。 |
| **推理 / 思考被吞**——思维链 delta 被丢弃。 | 作为 `agent_thought_chunk` 流式发送，"思考"面板正常渲染。 |
| **模型报错 = 静默冻结**——provider 死了，UI 永远转圈。 | 自动重试（每次都显示）+ 5 分钟不活动看门狗 + 空回复兜底。 |

## 环境要求

- **Node.js** ≥ 20
- **pi** 已安装并配置好（`~/.pi/agent/auth.json` 里有你的模型密钥）。
  适配器直接复用你已有的 pi 配置——不需要单独配密钥。

## 快速开始

```bash
git clone https://github.com/patrick-xin/pi-acp.git
cd pi-acp && npm install
```

注册为 Buzz custom harness（不改源码）：

```bash
cp pi.json.template ~/Library/Application\ Support/xyz.block.buzz.app/custom_harnesses/pi.json
# 编辑 pi.json——把 <PATH-TO-PI-ACP> 替换成你 clone 的真实路径
```

重启 Buzz → **pi** 出现在 Agent 运行时下拉菜单里，跟 Claude / Codex / Goose 并列。

> **Buzz `git pull` 永远不影响本项目**——它完全在源码树之外，就是
> 一个 custom harness + 一个独立 repo。

## 独立测试

```bash
npm test           # 冒烟：initialize + session/new
npm run test:e2e   # 完整：模型列表、systemPrompt 转发、工具调用显示
```

## 实现了什么

| ACP 方法 | 行为 |
|---|---|
| `initialize` | 握手；声明不支持 steering 扩展。 |
| `session/new` | 创建 pi session；返回 `sessionId` + `configOptions`（pi 的模型列表）+ `models.default`。 |
| `session/prompt` | 执行 prompt；流式发送 `agent_message_chunk` + `agent_thought_chunk` + `tool_call` + `tool_call_update`；返回 `stopReason`。 |
| `session/cancel` | 调用 `session.abort()`；返回 `stopReason: "cancelled"`。 |
| `session/set_model` | 解析并应用模型。 |
| `session/set_config_option` | 当 `configId="model"` 时应用模型（Buzz 走的路径）。 |

## 架构

这是一个**通用 ACP 适配器**，不是 Buzz 插件。它说的是标准
[Agent Client Protocol](https://github.com/agentclientprotocol)（NDJSON over
stdio）——跟 `@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`
是同一个协议。任何支持 ACP 的宿主（Buzz、Zed 等）都能驱动它。**零 Buzz
源码依赖**——只有 ACP 协议规范和 pi SDK。

## 许可证

[MIT](LICENSE)
