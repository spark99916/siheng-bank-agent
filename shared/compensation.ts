import type { BankState, ToolResult } from "./state.ts";
import { yuanText } from "./state.ts";

/**
 * 补偿事务：计划里前几步已经做了、后面一步失败时，把能撤的撤回去。
 *
 * 三条边界必须先说清，否则「回滚」只是个听起来很好的词：
 * 一、只回滚「有 undo」的步骤。钱已经走了的转账没有 undo，谁也不能假装能撤；
 * 二、undo 靠执行前拍的快照，不靠重新算一遍 —— 重算会把别人的并发改动一起吞掉；
 * 三、撤不掉的如实说「撤不掉」，不返回一个假的成功。
 */
export type Undo = (state: BankState) => ToolResult;

/** 每种工具的回滚可能：不可回滚、只读、可回滚。 */
export type RollbackKind = "compensable" | "irreversible" | "readonly";

export interface RollbackSpec {
  kind: RollbackKind;
  /** 给人看的理由，会进计划执行的逐条说明。 */
  reason: string;
}

const SPECS: Record<string, RollbackSpec> = {
  // 只读：没有副作用，谈不上回滚
  query_balance: { kind: "readonly", reason: "只读查询，没有需要撤销的改动" },
  analyze_bills: { kind: "readonly", reason: "只读查询，没有需要撤销的改动" },
  list_subscriptions: { kind: "readonly", reason: "只读查询，没有需要撤销的改动" },
  wealth_products: { kind: "readonly", reason: "只读查询，没有需要撤销的改动" },
  list_scheduled: { kind: "readonly", reason: "只读查询，没有需要撤销的改动" },
  fx_convert: { kind: "readonly", reason: "只读换算，没有需要撤销的改动" },

  // 可回滚：改动都落在本地状态上，能按执行前的快照复原
  lock_card: { kind: "compensable", reason: "卡片状态可以复原" },
  birthday_lock: { kind: "compensable", reason: "预锁资金可以释放" },
  birthday_order: { kind: "compensable", reason: "生日下单登记可以撤销，撤销时不产生退款" },
  split_collect: { kind: "compensable", reason: "AA 收款单可以作废，作废前没有真实资金流" },
  schedule_transfer: { kind: "compensable", reason: "预约单可以作废" },
  wealth_buy: { kind: "compensable", reason: "申购当日可撤单" },

  // 不可回滚：钱已离账或合约已终止
  transfer: { kind: "irreversible", reason: "转账一旦入账就不可撤销，只能与收款人协商退回" },
  wealth_redeem: { kind: "irreversible", reason: "赎回已成交，资金回到活期后不可逆" },
  cancel_subscription: { kind: "irreversible", reason: "订阅合约已终止，无法自动恢复原合约" },
  report_loss: { kind: "irreversible", reason: "挂失已生效，只能换卡" },
  apply_card: { kind: "irreversible", reason: "申请已提交到审批队列，不能撤回" },
  adjust_limit: { kind: "irreversible", reason: "额度调整需柜面办理，线上不执行" },
  freeze_account: { kind: "irreversible", reason: "账户冻结需柜面办理，线上不执行" },
};

export function rollbackOf(tool: string): RollbackSpec {
  return SPECS[tool] ?? { kind: "irreversible", reason: "未知工具，按不可回滚处理" };
}

const ok = (tool: string, message: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  message,
  ...(data === undefined ? {} : { data }),
});

/**
 * 执行前拍快照。返回 null 表示这一步没有 undo —— 调用方据此如实说明，而不是跳过不提。
 * 快照只取这一步会碰到的字段：整份 state 一起存会把并发改动也一起回退掉。
 */
export function captureUndo(tool: string, state: BankState): Undo | null {
  switch (tool) {
    case "lock_card": {
      const before = state.cards.map((card) => ({ id: card.id, status: card.status }));
      return (current) => {
        for (const item of before) {
          const card = current.cards.find((entry) => entry.id === item.id);
          if (card !== undefined) card.status = item.status;
        }
        return ok(tool, `已把 ${before.length} 张卡片的状态复原`);
      };
    }
    case "birthday_lock": {
      const beforeCount = state.lockedFunds.length;
      return (current) => {
        const removed = current.lockedFunds.splice(beforeCount);
        const released = removed.reduce((sum, item) => sum + item.amountCents, 0);
        current.account.available += released;
        return ok(tool, `已释放预锁资金 ${yuanText(released)} 元`);
      };
    }
    case "split_collect": {
      const beforeCount = state.collections.length;
      return (current) => {
        const removed = current.collections.splice(0, current.collections.length - beforeCount);
        for (const item of removed) item.status = "cancelled";
        return ok(tool, `已作废 ${removed.length} 张 AA 收款单，未发生任何资金划转`);
      };
    }
    case "birthday_order": {
      const beforeCount = state.birthdayGifts.length;
      return (current) => {
        const removed = current.birthdayGifts.splice(0, current.birthdayGifts.length - beforeCount);
        for (const item of removed) item.status = "cancelled";
        return ok(tool, `已撤销 ${removed.length} 笔生日下单登记，未发生扣款`);
      };
    }
    case "schedule_transfer": {
      const beforeCount = state.scheduledTransfers.length;
      return (current) => {
        const removed = current.scheduledTransfers.splice(beforeCount);
        for (const item of removed) item.status = "cancelled";
        return ok(tool, `已作废 ${removed.length} 笔预约转账`);
      };
    }
    case "wealth_buy": {
      const beforeBalance = state.account.balance;
      const beforeAvailable = state.account.available;
      const beforeCount = state.holdings.length;
      return (current) => {
        current.holdings.splice(beforeCount);
        current.account.balance = beforeBalance;
        current.account.available = beforeAvailable;
        return ok(tool, "已撤单，申购资金与费用退回活期");
      };
    }
    default:
      return null;
  }
}
