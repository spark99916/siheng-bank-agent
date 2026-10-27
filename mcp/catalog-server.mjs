#!/usr/bin/env node
// 理财费率服务：产品清单、费率解释、适当性校验。

import { runServer } from "./_server.mjs";

/** 演示产品：风险等级 1 到 5，年化收益为演示值。 */
const PRODUCTS = [
  { id: "p-001", name: "稳盈货币 A", riskLevel: 1, annualRate: 0.018, minAmountCents: 100, feeRate: 0 },
  { id: "p-002", name: "安享固收 90 天", riskLevel: 2, annualRate: 0.029, minAmountCents: 100000, feeRate: 0.001 },
  { id: "p-003", name: "平衡配置混合", riskLevel: 3, annualRate: 0.045, minAmountCents: 100000, feeRate: 0.006 },
  { id: "p-004", name: "进取成长股票", riskLevel: 4, annualRate: 0.072, minAmountCents: 500000, feeRate: 0.012 },
  { id: "p-005", name: "科技主题精选", riskLevel: 5, annualRate: 0.095, minAmountCents: 500000, feeRate: 0.015 },
];

const LEVEL_LABELS = { 1: "保守型", 2: "稳健型", 3: "平衡型", 4: "成长型", 5: "进取型" };

function findProduct(id) {
  const product = PRODUCTS.find((item) => item.id === id);
  if (product === undefined) throw new Error(`产品不存在：${id}`);
  return product;
}

const tools = [
  {
    name: "list_products",
    description: "列出理财产品，可按风险等级筛选",
    inputSchema: {
      type: "object",
      properties: { maxRiskLevel: { type: "integer", minimum: 1, maximum: 5 } },
      required: [],
      additionalProperties: false,
    },
    handler(args) {
      const max = Number(args.maxRiskLevel ?? 5);
      const items = PRODUCTS.filter((item) => item.riskLevel <= max).map((item) => ({
        ...item,
        riskLabel: LEVEL_LABELS[item.riskLevel],
        annualRateText: `${(item.annualRate * 100).toFixed(1)}%`,
      }));
      return { count: items.length, items };
    },
  },
  {
    name: "explain_fee",
    description: "解释某款产品的申购费与管理费",
    inputSchema: {
      type: "object",
      properties: { productId: { type: "string", enum: PRODUCTS.map((item) => item.id) } },
      required: ["productId"],
      additionalProperties: false,
    },
    handler(args) {
      const product = findProduct(String(args.productId));
      return {
        productId: product.id,
        name: product.name,
        feeRate: product.feeRate,
        feeText: product.feeRate === 0 ? "申购免费" : `申购费 ${(product.feeRate * 100).toFixed(2)}%`,
        note: "费率随持有时长变化，赎回费另计",
      };
    },
  },
  {
    name: "suitability",
    description: "校验产品风险与客户承受等级是否匹配",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", enum: PRODUCTS.map((item) => item.id) },
        customerRiskLevel: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["productId", "customerRiskLevel"],
      additionalProperties: false,
    },
    handler(args) {
      const product = findProduct(String(args.productId));
      const customer = Number(args.customerRiskLevel);
      const suitable = product.riskLevel <= customer;
      return {
        productId: product.id,
        customerRiskLevel: customer,
        customerLabel: LEVEL_LABELS[customer],
        productRiskLevel: product.riskLevel,
        productLabel: LEVEL_LABELS[product.riskLevel],
        suitable,
        reasons: suitable
          ? ["产品风险等级不高于客户承受等级"]
          : [`产品风险等级 ${product.riskLevel} 高于客户承受等级 ${customer}`],
        action: suitable ? "可以申购" : "需重新测评或更换产品",
      };
    },
  },
];

runServer({ name: "starter-catalog", version: "0.1.0", tools });
