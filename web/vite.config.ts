import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 页面默认在本地跑：`src/demo-local.ts` 把真正的 `track-pi/src/agent.ts` 与
 * `shared/` 编译进包，只把 Node 内置模块换成 `src/shims/` 里的浏览器替身。
 * 构建时必须在这里把这些指过去 —— 否则 vite 会把它们当 external，运行时抛
 * 「node:crypto 在浏览器里不可用」，页面直接白屏。
 */
const shim = (name: string) => fileURLToPath(new URL(`./src/shims/node-${name}.ts`, import.meta.url));

/** 开发时把 /rpc 转发到运行时，默认指向 pi 路线，可切到 cordis（只有 ?live=1 才会用到）。 */
export default defineConfig({
  /* 相对路径：dist/index.html 双击就能打开 —— file:// 下绝对路径 /assets/… 会指向盘根。 */
  base: "./",
  resolve: {
    alias: [
      { find: "node:async_hooks", replacement: shim("async-hooks") },
      { find: "node:crypto", replacement: shim("crypto") },
      { find: "node:fs", replacement: shim("fs") },
      { find: "node:path", replacement: shim("path") },
      { find: "node:os", replacement: shim("os") },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/rpc": {
        target: process.env.RPC_TARGET ?? "http://127.0.0.1:18150",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
