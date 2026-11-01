/**
 * `node:fs` 的浏览器替身：一个内存文件系统。
 *
 * 为什么连 fs 也要替 —— 因为 `FileStore` 是审计链、状态、幂等、工单四处共用的
 * 唯一落盘出口。把 fs 换成内存，离线模式跑的就是**同一份** FileStore，
 * 而不是另写一套"演示用的假存储"。内存盘刷新即清空，这一点在页面上明说。
 *
 * 只实现 persist.ts 真正用到的那几个函数；没用到的故意不实现，
 * 免得以后有人以为"这里也支持"。缺哪个会立刻抛错，不会静默返回空。
 */

type Entry = { content: string; dir: boolean };

const files = new Map<string, Entry>([["/", { content: "", dir: true }]]);
const handles = new Map<number, { path: string; position: number; append: boolean }>();
let nextFd = 3;

function key(raw: string): string {
  const slash = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return slash.length > 1 && slash.endsWith("/") ? slash.slice(0, -1) : slash;
}

function enoent(target: string): Error {
  const error = new Error(`ENOENT: no such file or directory, open '${target}'`);
  (error as Error & { code?: string }).code = "ENOENT";
  return error;
}

export function mkdirSync(target: string, _options?: { recursive?: boolean }): void {
  const name = key(target);
  if (name === "/") return;
  // 递归建父目录：FileStore 只建一层，但 path.resolve 之后可能是两级。
  const parts = name.split("/").filter(Boolean);
  let cursor = "";
  for (const part of parts) {
    cursor += `/${part}`;
    if (!files.has(cursor)) files.set(cursor, { content: "", dir: true });
  }
}

export function existsSync(target: string): boolean {
  return files.has(key(target));
}

export function readFileSync(target: string, encoding?: string): string | { byteLength: number; toString(): string } {
  const entry = files.get(key(target));
  if (entry === undefined || entry.dir) throw enoent(target);
  if (encoding === "utf8" || encoding === "utf-8") return entry.content;
  // persist.info() 用 readFileSync(file).byteLength 量审计文件大小；给个等价物。
  return { byteLength: new TextEncoder().encode(entry.content).length, toString: () => entry.content };
}

export function writeFileSync(target: string, data: string): void {
  files.set(key(target), { content: String(data), dir: false });
}

export function appendFileSync(target: string, data: string): void {
  const name = key(target);
  const entry = files.get(name);
  files.set(name, { content: (entry?.content ?? "") + String(data), dir: false });
}

export function openSync(target: string, flag = "r"): number {
  const name = key(target);
  const existing = files.get(name);
  // wx = 独占创建：文件已存在就抛 EEXIST。FileStore 的写锁靠这个语义抢锁，
  // 不能退化成普通 "w" —— 那样锁就永远抢得到，等于没锁。
  if ((flag === "wx" || flag === "x") && existing !== undefined) {
    const error = new Error(`EEXIST: file already exists, open '${target}'`);
    (error as Error & { code?: string }).code = "EEXIST";
    throw error;
  }
  if (existing === undefined && (flag === "r" || flag === "r+")) throw enoent(target);
  if (flag === "w" || flag === "wx") files.set(name, { content: "", dir: false });
  else if (existing === undefined) files.set(name, { content: "", dir: false });
  const fd = nextFd;
  nextFd += 1;
  handles.set(fd, {
    path: name,
    position: flag === "a" ? (files.get(name)?.content.length ?? 0) : 0,
    append: flag === "a",
  });
  return fd;
}

/** persist.ts 的僵尸锁检测只看 mtimeMs；内存盘里文件不会变旧，永远刚写完。 */
export function statSync(target: string): { mtimeMs: number; isFile(): boolean; isDirectory(): boolean } {
  const entry = files.get(key(target));
  if (entry === undefined) throw enoent(target);
  return { mtimeMs: Date.now(), isFile: () => !entry.dir, isDirectory: () => entry.dir };
}

export function writeSync(fd: number, data: string): number {
  const handle = handles.get(fd);
  if (handle === undefined) throw new Error(`EBADF: bad file descriptor ${fd}`);
  const entry = files.get(handle.path) ?? { content: "", dir: false };
  const text = String(data);
  if (handle.append) {
    entry.content += text;
    handle.position = entry.content.length;
  } else {
    entry.content = entry.content.slice(0, handle.position) + text + entry.content.slice(handle.position + text.length);
    handle.position += text.length;
  }
  files.set(handle.path, { content: entry.content, dir: false });
  return text.length;
}

export function fsyncSync(_fd?: number): void {
  // 内存盘没有"落盘"这回事。保留这个函数是为了让 FileStore 的调用形状不变 ——
  // 它调 fsync 的用意是"返回后不在缓存里"，在内存盘里天然成立。
}

export function closeSync(fd?: number): void {
  if (fd !== undefined) handles.delete(fd);
}

export function renameSync(from: string, to: string): void {
  const source = files.get(key(from));
  if (source === undefined) throw enoent(from);
  files.delete(key(from));
  files.set(key(to), source);
}

export function unlinkSync(target: string): void {
  if (!files.delete(key(target))) throw enoent(target);
}

/** 离线引擎自检用：看一眼内存盘里有什么（页面不调用）。 */
export function __files(): string[] {
  return [...files.keys()].filter((name) => files.get(name)?.dir !== true);
}

export default {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  statSync,
};
