#!/usr/bin/env node
// 把离线演示引擎打进 demo.html。
//
// 做法：用 esbuild 把 web/src/demo-local.ts（它 import 的是真正的 agent.ts）打成
// 一个 IIFE，并把 node:crypto / node:fs / node:path / node:os 换成 ./web/src/shims 下的替身。
// 产物内联进 web/public/demo.html 的标记之间，因此演示站仍然是**单文件**，
// 双击打开（file://）也能跑，不需要起服务。
//
// 为什么不用 <script src="./demo-engine.js">：那样就不是单文件了，
// 发出去、拖到别人电脑上、丢进提交包，都容易少一个文件。
//
// 运行：node scripts/build-demo-engine.mjs [--check]
//   --check 只编译并自检（不写文件），用于 CI。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(ROOT, "web/public/demo.html");
const DIST = path.join(ROOT, "web/dist/demo.html");
const ENTRY = path.join(ROOT, "web/src/demo-local.ts");
const START = "/*<<<LOCAL_ENGINE_START>>>*/";
const END = "/*<<<LOCAL_ENGINE_END>>>*/";

const SHIMS = {
  "node:crypto": path.join(ROOT, "web/src/shims/node-crypto.ts"),
  "node:fs": path.join(ROOT, "web/src/shims/node-fs.ts"),
  "node:path": path.join(ROOT, "web/src/shims/node-path.ts"),
  "node:os": path.join(ROOT, "web/src/shims/node-os.ts"),
  "node:async_hooks": path.join(ROOT, "web/src/shims/node-async-hooks.ts"),
};

/** esbuild 插件：把 node: 内置模块换成浏览器替身，其余不动。 */
const browserShims = {
  name: "node-shims",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      const shim = SHIMS[args.path];
      if (shim === undefined) {
        return { errors: [{ text: `离线引擎缺少 ${args.path} 的浏览器替身（${args.importer}）` }] };
      }
      return { path: shim };
    });
  },
};

const checkOnly = process.argv.includes("--check");

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  globalName: "SihengLocal",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "none",
  charset: "utf8",
  write: false,
  plugins: [browserShims],
});

const code = result.outputFiles[0].text;

/**
 * 自检：替身里的 SHA-256 必须和 Node 的实现逐字节一致。
 * 判定链的审计哈希、令牌 digest、幂等指纹全指着它 —— 差一位，整条链就对不上。
 */
const fixtures = ["", "abc", "转账 100 元", "a".repeat(1000), JSON.stringify({ seq: 1, tool: "transfer" })];
const shimModule = await import(pathToFileURL(SHIMS["node:crypto"]).href);
for (const text of fixtures) {
  const mine = shimModule.createHash("sha256").update(text).digest("hex");
  const node = createHash("sha256").update(text).digest("hex");
  if (mine !== node) {
    console.error(`[demo] SHA-256 替身与 Node 不一致：${JSON.stringify(text.slice(0, 20))}`);
    console.error(`  替身 ${mine}`);
    console.error(`  Node ${node}`);
    process.exit(1);
  }
}

const sizeKb = (code.length / 1024).toFixed(1);
console.log(`[demo] 引擎编译完成：${sizeKb} KB；SHA-256 替身与 Node 一致（${fixtures.length} 组）`);

if (checkOnly) process.exit(0);

const html = readFileSync(PAGE, "utf8");
const start = html.indexOf(START);
const end = html.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  console.error(`[demo] demo.html 里找不到注入标记：${START} … ${END}`);
  process.exit(1);
}

const next =
  html.slice(0, start + START.length) +
  `\n${code}\n` +
  html.slice(end);

if (next === html) {
  console.log("[demo] 内容未变，跳过写入");
} else {
  writeFileSync(PAGE, next, "utf8");
  console.log(`[demo] 已写入 ${path.relative(ROOT, PAGE)}（${sizeKb} KB）`);
}

if (existsSync(DIST)) {
  copyFileSync(PAGE, DIST);
  console.log("[demo] 已同步到 web/dist/demo.html");
}
