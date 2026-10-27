/**
 * Agent 循环：模型决策 → 框架执行 → 结果回灌 → 模型再决策，直到给出最终答复。
 *
 * 三条硬约束，写在这里而不是散在调用方：
 * 一、有界。maxSteps 用完必须停，不能靠模型自己说「我不调了」。
 * 二、可审计。每一步的输入、模型原始输出、耗时、token 都要能拿出来，否则「循环过」是空话。
 * 三、只读进循环。改变资金或状态的动作不允许在循环里自动执行 —— 那会绕过人工确认。
 *    这条由 canCall 强制，模型无权决定。
 */

import type { ChatMessage, ToolDecl, Transport } from "./transport.ts";

export interface LoopStep {
  index: number;
  /** seed：进入循环前已执行的一步；tool：循环内模型又发起的一步；final：模型给出答复。 */
  kind: "seed" | "tool" | "final";
  tool?: string;
  args?: string;
  result?: string;
  content?: string;
  rejected?: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface LoopResult {
  steps: LoopStep[];
  finalText: string;
  stopReason: "final" | "max-steps" | "error" | "empty";
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** 循环内模型实际发起的工具次数（不含 seed），用来判断「真的转了第二圈没有」。 */
  toolTurns: number;
  /** 传输层异常原因。有值即表示这一轮没有拿到有效答复。 */
  error?: string;
}

export interface LoopSeed {
  /** 进入循环前框架已经执行过的那一步，作为上下文交给模型，避免它重复调用。 */
  tool: string;
  args: string;
  result: string;
}

export interface LoopOptions {
  transport: Transport;
  system: string;
  user: string;
  tools: ToolDecl[];
  seed?: LoopSeed;
  /** 循环内最多允许模型再发起几次工具调用。用完就逼它给答复。 */
  maxSteps?: number;
  /** 白名单：返回 false 的工具调用会被拒绝，并把拒绝原因交回模型。 */
  canCall?: (name: string) => boolean;
  runTool: (name: string, args: string) => Promise<{ ok: boolean; text: string }>;
  maxTokens?: number;
  /** 每步回调，供调用方实时打印或留痕。 */
  onStep?: (step: LoopStep) => void;
}

/** 空答复：模型返回 200 但没有内容，也属于失败，不能当成功往下走。 */
const EMPTY = "";

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const maxSteps = options.maxSteps ?? 2;
  const steps: LoopStep[] = [];
  const startedAt = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let toolTurns = 0;

  const record = (step: LoopStep): void => {
    steps.push(step);
    promptTokens += step.promptTokens;
    completionTokens += step.completionTokens;
    options.onStep?.(step);
  };

  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];

  if (options.seed !== undefined) {
    const id = "seed-0";
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: options.seed.tool, arguments: options.seed.args }],
    });
    messages.push({ role: "tool", content: options.seed.result, toolCallId: id });
    record({
      index: 0,
      kind: "seed",
      tool: options.seed.tool,
      args: options.seed.args,
      result: options.seed.result,
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
  }

  for (let turn = 0; turn <= maxSteps; turn += 1) {
    // 工具名额用完时把工具表撤掉：只给一次「说人话」的机会，模型就没法再拖一轮。
    const tools = turn < maxSteps ? options.tools : [];
    let reply;
    try {
      reply = await options.transport.complete(messages, tools);
    } catch (error) {
      record({
        index: steps.length,
        kind: "final",
        content: "",
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
      });
      return {
        steps,
        finalText: EMPTY,
        stopReason: "error",
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - startedAt,
        toolTurns,
        // 错误信息单独带回，调用方负责降级，不让异常穿透到业务层。
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const call = reply.toolCalls[0];
    if (call !== undefined && tools.length > 0) {
      toolTurns += 1;
      const allowed = options.canCall === undefined ? true : options.canCall(call.name);
      if (!allowed) {
        record({
          index: steps.length,
          kind: "tool",
          tool: call.name,
          args: call.arguments,
          rejected: true,
          latencyMs: reply.latencyMs,
          promptTokens: reply.promptTokens,
          completionTokens: reply.completionTokens,
        });
        // 拒绝要回灌给模型，让它知道为什么不能调，而不是静默丢弃后自己编一个结果。
        const id = `call-${turn}`;
        messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: call.name, arguments: call.arguments }] });
        messages.push({
          role: "tool",
          content: `调用被拒绝：${call.name} 不在循环允许的只读工具内，需要用户确认后才能执行。`,
          toolCallId: id,
        });
        continue;
      }

      const executed = await options.runTool(call.name, call.arguments);
      record({
        index: steps.length,
        kind: "tool",
        tool: call.name,
        args: call.arguments,
        result: executed.text,
        latencyMs: reply.latencyMs,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
      });
      const id = `call-${turn}`;
      messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: call.name, arguments: call.arguments }] });
      messages.push({ role: "tool", content: executed.text, toolCallId: id });
      continue;
    }

    const content = reply.content.trim();
    if (call !== undefined && tools.length === 0) {
      // 工具名额已用尽、模型还想调：这属于「撞上步数上限」，不是「模型没说话」。
      record({
        index: steps.length,
        kind: "tool",
        tool: call.name,
        args: call.arguments,
        rejected: true,
        latencyMs: reply.latencyMs,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
      });
      return {
        steps,
        finalText: content,
        stopReason: "max-steps",
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - startedAt,
        toolTurns,
      };
    }

    record({
      index: steps.length,
      kind: "final",
      content,
      latencyMs: reply.latencyMs,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
    });
    return {
      steps,
      finalText: content,
      stopReason: content === "" ? "empty" : "final",
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - startedAt,
      toolTurns,
    };
  }

  // 名额用尽仍未给出答复：如实上报，由调用方决定降级文案。
  return {
    steps,
    finalText: EMPTY,
    stopReason: "max-steps",
    promptTokens,
    completionTokens,
    latencyMs: Date.now() - startedAt,
    toolTurns,
  };
}
