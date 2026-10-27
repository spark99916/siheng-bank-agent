#!/usr/bin/env node
// 汇率与跨境服务：演示用固定汇率，不接真实行情。

import { runServer } from "./_server.mjs";

/** 基准汇率：1 单位外币兑人民币。 */
const RATES = {
  USD: 7.12,
  EUR: 7.78,
  JPY: 0.047,
  HKD: 0.91,
  GBP: 9.05,
};

const LABELS = {
  USD: "美元",
  EUR: "欧元",
  JPY: "日元",
  HKD: "港币",
  GBP: "英镑",
};

function requireCurrency(code) {
  if (typeof code !== "string" || RATES[code.toUpperCase()] === undefined) {
    throw new Error(`不支持的币种：${code}`);
  }
  return code.toUpperCase();
}

const tools = [
  {
    name: "list_currencies",
    description: "列出支持的币种与当前演示汇率",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    handler() {
      return {
        base: "CNY",
        items: Object.entries(RATES).map(([code, rate]) => ({
          code,
          label: LABELS[code],
          rate,
          text: `1 ${LABELS[code]} = ${rate} 元`,
        })),
      };
    },
  },
  {
    name: "get_rate",
    description: "查询单个币种兑人民币的汇率",
    inputSchema: {
      type: "object",
      properties: { currency: { type: "string", enum: Object.keys(RATES) } },
      required: ["currency"],
      additionalProperties: false,
    },
    handler(args) {
      const code = requireCurrency(args.currency);
      return { currency: code, label: LABELS[code], rate: RATES[code], base: "CNY" };
    },
  },
  {
    name: "convert",
    description: "把外币金额换算成人民币，金额单位元",
    inputSchema: {
      type: "object",
      properties: {
        currency: { type: "string", enum: Object.keys(RATES) },
        amount: { type: "number", description: "外币金额，单位元" },
      },
      required: ["currency", "amount"],
      additionalProperties: false,
    },
    handler(args) {
      const code = requireCurrency(args.currency);
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount 必须是正数");
      const converted = Math.round(amount * RATES[code] * 100) / 100;
      return {
        currency: code,
        amount,
        rate: RATES[code],
        converted,
        text: `${amount} ${LABELS[code]} 约合 ${converted.toFixed(2)} 元`,
        note: "演示汇率，不构成真实报价",
      };
    },
  },
];

runServer({ name: "starter-fx", version: "0.1.0", tools });
