import { defineConfig } from "vite";

/** 开发时把 /rpc 转发到运行时，默认指向 pi 路线，可切到 cordis。 */
export default defineConfig({
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
