import { spawn } from "node:child_process";
const child = spawn("node", ["pi-acp.mjs"], { stdio: ["pipe","pipe","pipe"] });
let buf = "";
const rl = await import("node:readline").then(m=>m.createInterface({input:child.stdout}));
let sid;
for await (const line of rl) {
  const m = JSON.parse(line);
  if (m.id === 1) console.log("✓ initialize:", m.result?.protocolVersion);
  if (m.id === 2) { sid = m.result?.sessionId; console.log("✓ session/new:", sid?.slice(0,8), "models:", m.result?.configOptions?.[0]?.options?.length); }
  if (sid) break;
}
child.stdin.end();
