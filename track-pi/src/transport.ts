/** 传输层：pi 三段式的第一段。只负责把消息发给模型并拿回结构化结果。 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  content: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface Transport {
  readonly model: string;
  readonly available: boolean;
  complete(messages: ChatMessage[], tools: ToolDecl[]): Promise<ModelReply>;
}

export interface TransportSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 关闭思考模式：抽槽不需要推理，可省下全部 reasoning token。 */
  thinking: boolean;
}

/** 从环境变量读配置：缺密钥时返回不可用，运行时自动退回规则。 */
export function readTransportSettings(): TransportSettings {
  const apiKey = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
  return {
    baseUrl,
    apiKey,
    model: process.env.LLM_MODEL ?? "deepseek-flash",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000),
    thinking: process.env.LLM_THINKING !== "off",
  };
}

/** HTTP 传输：OpenAI 兼容接口，只用 fetch，不引 SDK。 */
export function createHttpTransport(settings: TransportSettings): Transport {
  return {
    model: settings.model,
    available: settings.apiKey !== "",
    async complete(messages, tools) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      try {
        const body: Record<string, unknown> = {
          model: settings.model,
          messages,
          temperature: 0,
          max_tokens: 400,
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

        const response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`模型返回 ${response.status}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const message = payload.choices?.[0]?.message ?? {};
        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        return {
          content: typeof message.content === "string" ? message.content : "",
          toolCalls: rawCalls
            .map((item: { function?: { name?: unknown; arguments?: unknown } }) => ({
              name: typeof item.function?.name === "string" ? item.function.name : "",
              arguments: typeof item.function?.arguments === "string" ? item.function.arguments : "{}",
            }))
            .filter((call: { name: string }) => call.name !== ""),
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          latencyMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
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
