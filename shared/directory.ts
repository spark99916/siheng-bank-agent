/**
 * 客户目录：这个进程里到底有哪几个人。
 *
 * 为什么要单独一个文件：身份不能藏在「渠道传了什么」里。渠道能递进来的只有一枚令牌，
 * 令牌能换出谁，只能由这张表决定 —— 否则客户端传一句 `actor: { userId: "u-1002" }`
 * 就能把别人的账户当成自己的。
 *
 * 三条边界，对应「客户之间看不见」：
 * 一、**姓名可见**。转账要核对收款人是谁，连名字都不给就没法确认，这不是隐私是业务前提。
 * 二、**金额不可见**。对外只给「有没有这个人」，不给余额，也不给「余额是不是 0」。
 * 三、**令牌只换身份，不换权限范围**。拿 u-1002 的令牌，也只能动 u-1002 的账。
 *
 * 生产环境里这三个字段都不该长这样：令牌来自 OIDC 的 `sub`，姓名来自客户主数据，
 * 档位来自账户系统（不是令牌里的 claim，claim 是签名方给的，改了授权就形同虚设）。
 * 这里用一张写死的表，是为了让整条链路在没有外部依赖时也能跑通并测得住。
 */

import { TIER_LABEL, type Tier } from "./rules.ts";

export interface Customer {
  userId: string;
  /** 账户姓名。可以被其他客户看到 —— 转账要核对。 */
  name: string;
  /** 权限档位。只由服务端查这张表得出，不接受客户端自报。 */
  tier: Tier;
  /** 演示令牌：生产环境换成 OIDC access token，服务端验签取 sub。 */
  token: string;
  /**
   * 各人的初始账户，金额互不相同。
   * 不一样不是随手编的：演示隔离时，两个账户余额一样就看不出「切过去以后确实换人了」。
   */
  seed: {
    balanceCents: number;
    availableCents: number;
  };
  /** 给界面用的一句话身份说明，进审计也会带上。 */
  note: string;
}

/**
 * 演示客户表。
 *
 * 四个人分属三个档位，是为了让「档位决定红线」这件事在演示里看得见：
 * 同一个金额，普通客户要确认，私行客户可能直接过；反过来普通客户根本办不了的，金卡以上能办。
 */
export const CUSTOMERS: readonly Customer[] = [
  {
    userId: "u-1001",
    name: "林知远",
    tier: "standard",
    token: "tok-demo-lin",
    seed: { balanceCents: 3864250, availableCents: 3864250 },
    note: "普通客户·主演示账户",
  },
  {
    userId: "u-1002",
    name: "周雅",
    tier: "gold",
    token: "tok-demo-zhou",
    seed: { balanceCents: 1280000, availableCents: 1280000 },
    note: "金卡客户",
  },
  {
    userId: "u-1003",
    name: "陈默",
    tier: "standard",
    token: "tok-demo-chen",
    seed: { balanceCents: 560000, availableCents: 560000 },
    note: "普通客户·低余额",
  },
  {
    userId: "u-1004",
    name: "苏晚",
    tier: "private",
    token: "tok-demo-su",
    seed: { balanceCents: 9800000, availableCents: 9800000 },
    note: "私行客户",
  },
];

/** 没有令牌时落到谁：保持单用户形态的老行为，演示站和旧探针不必改。 */
export const DEFAULT_CUSTOMER: Customer = CUSTOMERS[0] as Customer;

/** 令牌换身份。换不出就是换不出，不回落成「随便给一个」。 */
export function customerByToken(token: string): Customer | null {
  if (token === "") return null;
  for (const item of CUSTOMERS) {
    if (item.token === token) return item;
  }
  return null;
}

/**
 * 按姓名找人。只返回这一个客户的姓名与档位，**不带任何金额字段**。
 *
 * 转账时用得上：「转给周雅」要先确认本行有没有这个人。
 * 但确认到「有这么个人」就够了，余额是对方的事。
 */
export function customerByName(name: string): Customer | null {
  const target = name.replace(/\s+/g, "");
  if (target === "") return null;
  for (const item of CUSTOMERS) {
    if (item.name === target) return item;
  }
  return null;
}

/** 按 userId 取人。服务端内部用，不对外。 */
export function customerById(userId: string): Customer | null {
  for (const item of CUSTOMERS) {
    if (item.userId === userId) return item;
  }
  return null;
}

/**
 * 对外可见的名册：只有姓名和档位。
 *
 * 这里刻意不返回 userId、余额、开户时间、最近交易 ——
 * 只要返回值里出现一个金额字段，前端就可能把它渲染出来，隔离就漏了。
 * 新增字段前先问一句：这个字段被别的客户看到，会不会出事。
 */
export interface PublicEntry {
  name: string;
  tierLabel: string;
}

export function publicDirectory(): PublicEntry[] {
  return CUSTOMERS.map((item) => ({ name: item.name, tierLabel: TIER_LABEL[item.tier] }));
}
