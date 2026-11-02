/**
 * `node:path` 的浏览器替身：只做 POSIX 风格的拼接与规整。
 *
 * 内存盘里没有盘符，所以不需要 Windows 分支 —— 这一点和宿主操作系统无关，
 * 反而让离线模式的路径行为在任何机器上都一致。
 */

function normalize(input: string): string {
  const absolute = input.startsWith("/");
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== "").join("/"));
}

export function resolve(...parts: string[]): string {
  const joined = parts.filter((part) => part !== "").join("/");
  return normalize(joined.startsWith("/") ? joined : `/${joined}`);
}

export function dirname(target: string): string {
  const clean = normalize(target);
  const cut = clean.lastIndexOf("/");
  return cut <= 0 ? "/" : clean.slice(0, cut);
}

export function basename(target: string): string {
  const clean = normalize(target);
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/**
 * 是不是绝对路径。
 *
 * 内存盘里没有盘符，所以 POSIX 风格的 `/` 开头就是绝对路径 ——
 * 这与宿主操作系统无关，反而让离线模式的行为在任何机器上都一致。
 *
 * 为什么需要它：`path.join(dir, "/abs")` 不会丢弃前面的部分，
 * 会拼成 `dir/abs`。真实 Node 在 Windows 上还会拼成 `dir\C:\abs` ——
 * 那种怪路径报出来的 EPERM 完全看不出是「传了绝对路径」。
 * 存储层统一在这里拦一次，错误信息才说得清。
 */
export function isAbsolute(target: string): boolean {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
}

export const sep = "/";

export default { join, resolve, dirname, basename, isAbsolute, sep };
