/**
 * `node:crypto` 的浏览器替身（只给离线演示引擎用）。
 *
 * 判定链用哈希是**同步**的（`AuditChain.append` 里直接算完写进记录），
 * 而浏览器的 `crypto.subtle.digest` 是异步的 —— 所以这里自带一份 SHA-256。
 * 不是"近似值"：实现就是 FIPS 180-4 的标准算法，构建时会拿 Node 的
 * `createHash("sha256")` 逐字节比对，不一致就构建失败。
 */

// 前 64 个质数立方根小数部分的前 32 位
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class Sha256 {
  private h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private total = 0;
  private readonly w = new Uint32Array(64);

  update(chunk: string | Uint8Array): this {
    const bytes = typeof chunk === "string" ? utf8(chunk) : chunk;
    this.total += bytes.length;
    let index = 0;

    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, bytes.length);
      this.block.set(bytes.subarray(0, take), this.blockLen);
      this.blockLen += take;
      index = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }

    for (; index + 64 <= bytes.length; index += 64) this.compress(bytes, index);

    if (index < bytes.length) {
      this.block.fill(0);
      this.block.set(bytes.subarray(index), 0);
      this.blockLen = bytes.length - index;
    }
    return this;
  }

  digest(encoding: "hex" | "base64" = "hex"): string {
    const bits = this.total * 8;
    const padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(padLen, Math.floor(bits / 4294967296));
    view.setUint32(padLen + 4, bits >>> 0);
    this.update(tail);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.h[i] as number);
    return encoding === "base64" ? base64(out) : hex(out);
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] = ((bytes[p] as number) << 24) | ((bytes[p + 1] as number) << 16) | ((bytes[p + 2] as number) << 8) | (bytes[p + 3] as number);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 = ((h as number) + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj = ((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.h[0] = ((this.h[0] as number) + (a as number)) >>> 0;
    this.h[1] = ((this.h[1] as number) + (b as number)) >>> 0;
    this.h[2] = ((this.h[2] as number) + (c as number)) >>> 0;
    this.h[3] = ((this.h[3] as number) + (d as number)) >>> 0;
    this.h[4] = ((this.h[4] as number) + (e as number)) >>> 0;
    this.h[5] = ((this.h[5] as number) + (f as number)) >>> 0;
    this.h[6] = ((this.h[6] as number) + (g as number)) >>> 0;
    this.h[7] = ((this.h[7] as number) + (h as number)) >>> 0;
  }
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createHash(algorithm: string): Sha256 {
  if (algorithm !== "sha256") throw new Error(`离线引擎只实现了 sha256，收到 ${algorithm}`);
  return new Sha256();
}

export function randomUUID(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const c = globalThis.crypto;
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export default { createHash, randomUUID, randomBytes };
