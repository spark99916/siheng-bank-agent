/**
 * `node:os` 的浏览器替身：只为让 transport.ts 的密钥查找路径能构造出来。
 *
 * 离线模式下不会去读密钥（`useModel: false`，传输层是 offline），
 * 所以这里返回的目录永远用不上 —— 但它必须存在，否则 import 就失败。
 */

export function homedir(): string {
  return "/home/demo";
}

export function platform(): string {
  return "browser";
}

export function tmpdir(): string {
  return "/tmp";
}

export default { homedir, platform, tmpdir };
