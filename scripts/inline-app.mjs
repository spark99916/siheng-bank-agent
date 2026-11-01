/**
 * 把 vite 的构建产物收成一个文件：`web/dist/index.html` 内联 JS 与 CSS。
 *
 * 为什么必须内联：`file://` 下 `<script type="module" src="./assets/x.js">` 会被
 * CORS 拦（origin 是 null），双击打开就是白屏。内联进同一个文档不涉及任何请求，
 * 这是让「双击就能用」成立的最短路径，也不用为演示加一个静态服务器。
 *
 * 用法：node scripts/inline-app.mjs
 *   前置：npm --prefix web run build（vite 输出到 web/dist）
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "web", "dist");
const HTML = path.join(DIST, "index.html");

if (!existsSync(HTML)) {
  console.error(`[inline] 找不到 ${HTML}，先跑 npm --prefix web run build`);
  process.exit(1);
}

let html = readFileSync(HTML, "utf8");
let inlinedJs = 0;
let inlinedCss = 0;

/** 内联脚本里出现 `</script>` 会提前收尾，转义掉。 */
const escapeForScript = (code) => code.replace(/<\/script>/gi, "<\\/script>");

html = html.replace(
  /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi,
  (match, href) => {
    const file = path.join(DIST, href.replace(/^\.\//, ""));
    if (!existsSync(file)) return match;
    inlinedCss += 1;
    return `<style>\n${readFileSync(file, "utf8")}\n</style>`;
  },
);

html = html.replace(
  /<script\b([^>]*)src="([^"]+)"([^>]*)><\/script>/gi,
  (match, before, src, after) => {
    if (!/\.js(\?|$)/.test(src)) return match;
    const file = path.join(DIST, src.replace(/^\.\//, ""));
    if (!existsSync(file)) return match;
    inlinedJs += 1;
    /* 产物是单块、没有 export/import 语句，所以去掉 type="module" 也能跑，
       而且普通脚本在 file:// 下不受模块的 CORS 限制。 */
    const attrs = `${before}${after}`
      .replace(/\btype="module"/g, "")
      .replace(/\bcrossorigin\b/g, "")
      .trim();
    return `<script${attrs === "" ? "" : ` ${attrs}`}>\n${escapeForScript(readFileSync(file, "utf8"))}\n</script>`;
  },
);

if (inlinedJs === 0) {
  console.error("[inline] 一个脚本都没内联上，产物结构可能变了 —— 拒绝写半成品");
  process.exit(1);
}

/* vite 把入口脚本放在 <head>（module 默认 defer，那时 DOM 还没好也没关系）。
   去掉 type="module" 之后它就是普通脚本，会立刻执行、查不到元素 —— 所以整块挪到
   </body> 前面，让它在结构就位之后再跑。 */
const blocks = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]);
if (blocks.length > 0) {
  html = html.replace(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<\/body>/i, `${blocks.join("\n")}\n  </body>`);
}

writeFileSync(HTML, html, "utf8");
console.log(`[inline] 已内联 ${inlinedJs} 个脚本、${inlinedCss} 个样式表 → web/dist/index.html`);
console.log(`[inline] 单文件大小：${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);

/* 内联完 assets 就是死文件了。留着容易让人以为还在引用，删掉更省事；
   demo.html 是 public 拷过来的，不在 assets 里，不受影响。 */
const assets = path.join(DIST, "assets");
if (existsSync(assets)) {
  const leftover = readdirSync(assets).filter((name) => /\.(js|css)$/.test(name));
  const stillReferenced = leftover.filter((name) => html.includes(name));
  if (stillReferenced.length > 0) {
    console.warn(`[inline] 仍有未被内联的引用，保留 assets：${stillReferenced.join(", ")}`);
  } else {
    rmSync(assets, { recursive: true, force: true });
    console.log(`[inline] 已清理 assets/（${leftover.length} 个文件已并入 HTML）`);
  }
}
