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

export const sep = "/";

export default { join, resolve, dirname, basename, sep };
