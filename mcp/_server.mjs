#!/usr/bin/env node
// MCP 服务端最小实现：基于 stdio 的 JSON-RPC，支持 initialize、tools/list、tools/call。

import { createInterface } from "node:readline";

/**
 * 启动服务端。
 * @param {{ name: string, version: string, tools: Array<{ name: string, description: string, inputSchema: object, handler: (args: object) => unknown }> }} options
 */
export function runServer(options) {
  const { name, version, tools } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const send = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = (message) => {
    const { id, method, params } = message;

    if (method === "initialize") {
      reply(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name, version },
        capabilities: { tools: {} },
      });
      return;
    }

    if (method === "notifications/initialized" || id === undefined) return;

    if (method === "tools/list") {
      reply(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const tool = byName.get(toolName);
      if (tool === undefined) {
        fail(id, -32601, `未注册的工具：${toolName}`);
        return;
      }
      try {
        const value = tool.handler(params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
      } catch (error) {
        reply(id, {
          content: [{ type: "text", text: `调用失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        });
      }
      return;
    }

    fail(id, -32601, `未实现的方法：${method}`);
  };

  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const text = line.trim();
    if (text === "") return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    handle(message);
  });
}
