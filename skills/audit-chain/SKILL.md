---
name: 审计链
description: 追加式审计记录、前序哈希成链、篡改检测与脱敏。写审计模块或答辩前准备证据时加载。
tags: [审计, 哈希, 脱敏, 可追溯]
---

# 审计链

## 何时用这个技能

需要证明「系统做过什么、没做过什么、记录没被改过」。

评委常问「怎么证明审计没被改」，这个技能就是答案。

## 记录结构

一条记录一个 JSON 对象，只追加，不改写。

```ts
interface AuditRecord {
  seq: number          // 序号，从 1 递增
  ts: string           // ISO 时间
  sessionId: string
  actor: string
  userText: string     // 已脱敏
  tool: string
  params: object       // 已脱敏
  decision: string     // 判定结论
  policyLevel: string  // 绿黄红
  policyRules: string[]
  tokenDigest?: string
  result: string
  prevHash: string     // 上一条的 hash，首条为 "GENESIS"
  hash: string         // 本条内容加 prevHash 的摘要
}
```

## 哈希算法

选用 SHA-256，输入是「前序哈希 + 规范化后的本条内容」。

规范化要点三条。

字段顺序固定，不依赖对象自身顺序。

空值统一成空字符串，不要 `undefined` 与 `null` 混用。

JSON 序列化不加空格，`JSON.stringify` 默认行为即可。

代码示例。

```ts
function hashOf(prevHash: string, payload: string): string {
  return createHash("sha256").update(`${prevHash}|${payload}`).digest("hex");
}
```

## 校验

从第一条读到最后一条，逐条重算。

```ts
let prev = "GENESIS"
for (const record of records) {
  const payload = canonical(record)
  const expect = hashOf(prev, payload)
  if (record.hash !== expect) return { ok: false, brokenAt: record.seq }
  if (record.prevHash !== prev) return { ok: false, brokenAt: record.seq }
  prev = record.hash
}
```

三种破坏都能发现：改内容、改哈希、删中间一条。

## 脱敏

写进审计前先脱敏，不要写完再洗。

| 字段 | 处理 |
|---|---|
| 卡号 | 保留后四位，前面用星号 |
| 手机号 | 保留前三后四 |
| 姓名 | 保留姓，名用星号 |
| 密钥 | 直接替换成固定串 |

脱敏函数只有一处，所有写入路径都走它。

## 答辩演示

现场演示分三步，两分钟。

一、展示审计列表，指出序号连续、链校验通过。

二、用编辑器改一条记录的 `result` 字段，保存。

三、刷新页面，链校验变成失败，指出断裂位置。

这个演示比任何文字说明都有说服力。

## 验收

正常追加后校验通过。

改任意一条内容后校验失败，且能指出断在第几条。

删中间一条后校验失败。

审计文件里搜不到明文卡号与手机号。

## 反模式

用数据库自增主键当唯一保障。主键防不住改内容。

每条记录独立哈希，不成链。这样改一条发现不了。

把脱敏放在展示层。日志文件里仍是明文，等于没脱敏。

审计写入失败不影响主流程，但不许静默。至少要记一条错误日志。
