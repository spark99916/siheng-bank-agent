#!/usr/bin/env node
// 反欺诈与征信服务：规则式评分，演示用。

import { runServer } from "./_server.mjs";

/** 高风险特征词：命中即抬高评分。 */
const RISK_WORDS = ["刷单", "博彩", "投资群", "返利", "跑分", "代付"];

const tools = [
  {
    name: "screen_payee",
    description: "转账前筛查收款人，返回风险等级与建议",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "收款人姓名或备注" },
        amountCents: { type: "integer", description: "金额，单位分" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler(args) {
      const name = String(args.name ?? "");
      const amountCents = Number(args.amountCents ?? 0);
      const hits = RISK_WORDS.filter((word) => name.includes(word));
      if (amountCents >= 500000) hits.push("大额收款人");
      const level = hits.length === 0 ? "low" : hits.length === 1 ? "medium" : "high";
      return {
        name,
        riskLevel: level,
        hits,
        advice: level === "low" ? "可正常受理" : level === "medium" ? "建议二次确认" : "建议人工复核",
      };
    },
  },
  {
    name: "fraud_signals",
    description: "列出常见的诈骗话术特征，供提示用户参考",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    handler() {
      return {
        signals: [
          "要求立刻转账、不许挂电话",
          "自称客服要求共享屏幕",
          "承诺高回报、要求先交保证金",
          "要求转到所谓安全账户",
          "通过陌生链接下载应用",
        ],
        advice: "遇到以上任一情形，先挂断并拨打官方客服核实",
      };
    },
  },
  {
    name: "credit_score",
    description: "按账户历史给出演示信用分与等级",
    inputSchema: {
      type: "object",
      properties: { monthsActive: { type: "integer" }, overdueCount: { type: "integer" } },
      required: [],
      additionalProperties: false,
    },
    handler(args) {
      const months = Number(args.monthsActive ?? 24);
      const overdue = Number(args.overdueCount ?? 0);
      const score = Math.max(300, Math.min(850, 700 + Math.min(months, 60) - overdue * 40));
      const level = score >= 750 ? "优秀" : score >= 650 ? "良好" : score >= 550 ? "一般" : "偏低";
      return { score, level, monthsActive: months, overdueCount: overdue };
    },
  },
];

runServer({ name: "starter-risk", version: "0.1.0", tools });
