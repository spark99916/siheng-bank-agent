/** 传输层：pi 三段式的第一段。只负责把消息发给模型并拿回结构化结果。 */

export interface ToolCallRef {
  id: string;
  name: string;
  /** 模型给的参数是 JSON 字符串，解析与校验由调用方做，传输层不猜。 */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 消息里模型发起的工具调用，供下一轮把结果回灌。 */
  toolCalls?: ToolCallRef[];
  /** role=tool 时对应哪一次工具调用。 */
  toolCallId?: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  content: string;
  toolCalls: Array<{ name: string; arguments: string; id?: string }>;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** OpenAI 兼容字段，用于区分「正常结束」与「被长度截断」。 */
  finishReason?: string;
}

/** 用量快照：真跑线上接口时，「花了多少 token」必须是可读出来的数字，不能靠估。 */
export interface UsageSnapshot {
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface Transport {
  readonly model: string;
  readonly available: boolean;
  complete(messages: ChatMessage[], tools: ToolDecl[]): Promise<ModelReply>;
  /** 累计用量。离线传输没有这层概念，返回 undefined。 */
  usage?: () => UsageSnapshot;
}

export interface TransportSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 关闭思考模式：抽槽与改写都不需要推理，可省下全部 reasoning token。 */
  thinking: boolean;
  /** 单次输出上限。循环里要给答复留空间，400 这种小值会把话截断。 */
  maxTokens: number;
  /** 429/5xx 的重试次数。真跑线上接口时这是必需项，不是优化项。 */
  retries: number;
}

/** 官方模型名：deepseek-flash 即 DeepSeek-V4.1-Flash-1017。旧名仍可调用但会按 Flash 计费。 */
export const DEFAULT_MODEL = "deepseek-flash";

/** 从环境变量读配置：缺密钥时返回不可用，运行时自动退回规则。 */
export function readTransportSettings(): TransportSettings {
  const apiKey = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  return {
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey,
    model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30000),
    thinking: process.env.LLM_THINKING !== "off",
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 800),
    retries: Number(process.env.LLM_RETRIES ?? 2),
  };
}

/** 内部消息形状 → OpenAI 兼容线格式。字段名不对，模型会看不到工具结果。 */
function toWire(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        // 带工具调用时 content 允许为空，但显式给 null 比空串更符合接口约定。
        content: message.content === "" ? null : message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP 传输：OpenAI 兼容接口，只用 fetch，不引 SDK。 */
export function createHttpTransport(settings: TransportSettings): Transport {
  const usage: UsageSnapshot = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  return {
    model: settings.model,
    available: settings.apiKey !== "",
    usage: () => ({ ...usage }),
    async complete(messages, tools) {
      const started = Date.now();
      const body: Record<string, unknown> = {
        model: settings.model,
        messages: toWire(messages),
        temperature: 0,
        max_tokens: settings.maxTokens,
        stream: false,
      };
      if (tools.length > 0) {
        body.tools = tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        body.tool_choice = settings.thinking ? "auto" : "required";
      }
      if (!settings.thinking) body.thinking = { type: "disabled" };

      let lastError = "";
      for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
        try {
          const response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!response.ok) {
            // 把响应体带回来：401 与 404 的处置完全不同，只说状态码等于让人去猜。
            const detail = (await response.text()).slice(0, 300).replace(/\s+/g, " ");
            lastError = `模型返回 ${response.status}：${detail}`;
            if (RETRYABLE.has(response.status) && attempt < settings.retries) {
              await sleep(400 * (attempt + 1));
              continue;
            }
            throw new Error(lastError);
          }
          const payload = (await response.json()) as {
            choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const choice = payload.choices?.[0];
          usage.calls += 1;
          usage.promptTokens += payload.usage?.prompt_tokens ?? 0;
          usage.completionTokens += payload.usage?.completion_tokens ?? 0;
          usage.latencyMs += Date.now() - started;
          const message = choice?.message ?? {};
          const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          return {
            content: typeof message.content === "string" ? message.content : "",
            toolCalls: rawCalls
              .map((item: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }) => ({
                id: typeof item.id === "string" ? item.id : undefined,
                name: typeof item.function?.name === "string" ? item.function.name : "",
                arguments: typeof item.function?.arguments === "string" ? item.function.arguments : "{}",
              }))
              .filter((call: { name: string }) => call.name !== ""),
            promptTokens: payload.usage?.prompt_tokens ?? 0,
            completionTokens: payload.usage?.completion_tokens ?? 0,
            latencyMs: Date.now() - started,
            finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
          };
        } catch (error) {
          // 超时（AbortError）也重试；但重试耗尽后要把真实原因抛出去，不能吞成空答复。
          const message = error instanceof Error ? error.message : String(error);
          lastError = message === "This operation was aborted" || message.includes("aborted") ? `模型请求超时（${settings.timeoutMs}ms）` : message;
          if (attempt < settings.retries && (lastError.includes("超时") || RETRYABLE.has(Number(lastError.match(/模型返回 (\d+)/)?.[1] ?? 0)))) {
            await sleep(400 * (attempt + 1));
            continue;
          }
          usage.failures += 1;
          throw new Error(lastError);
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error(lastError === "" ? "模型调用失败" : lastError);
    },
  };
}

/** 规则传输：不调模型，永远返回空工具调用，用于离线演示。 */
export function createOfflineTransport(): Transport {
  return {
    model: "offline",
    available: false,
    async complete() {
      return { content: "", toolCalls: [], promptTokens: 0, completionTokens: 0, latencyMs: 0 };
    },
  };
}
