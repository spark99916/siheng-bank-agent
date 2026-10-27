#!/usr/bin/env node
// 外部服务自检：逐个启动服务，握手、列工具、各调一次，打印结果。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 每个服务一条代表调用。 */
const TARGETS = [
  ["fx-server.mjs", "convert", { currency: "USD", amount: 100 }],
  ["risk-server.mjs", "screen_payee", { name: "王晓明", amountCents: 80000 }],
  ["catalog-server.mjs", "suitability", { productId: "p-004", customerRiskLevel: 2 }],
];

/** 启动一个服务，返回 JSON-RPC 调用器。 */
function connect(script) {
  const child = spawn(process.execPath, [path.join(here, script)], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let seq = 0;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line === "") continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter !== undefined) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    }
  });

  const call = (method, params) => {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 8000);
    });
  };

  return { call, close: () => child.kill() };
}

let failed = 0;
for (const [script, tool, args] of TARGETS) {
  const client = connect(script);
  try {
    const init = await client.call("initialize", {});
    const list = await client.call("tools/list", {});
    const result = await client.call("tools/call", { name: tool, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    console.log(`[ok] ${init.serverInfo.name} 工具 ${list.tools.length} 个：${list.tools.map((item) => item.name).join("、")}`);
    console.log(`     样例 ${tool}：${text.slice(0, 120)}`);
  } catch (error) {
    failed += 1;
    console.log(`[fail] ${script}：${error.message}`);
  } finally {
    client.close();
  }
}

console.log("");
console.log(failed === 0 ? "外部服务全部可用" : `${failed} 个服务不可用`);
process.exit(failed === 0 ? 0 : 1);
