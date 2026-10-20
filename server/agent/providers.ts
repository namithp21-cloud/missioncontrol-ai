/**
 * Language-model provider abstraction. The agent only talks to the LLMProvider interface, so switching vendors
 * is a configuration change (LLM_PROVIDER), not a rewrite.
 *
 *   LLM_PROVIDER=anthropic      -> Anthropic Messages API       (ANTHROPIC_API_KEY, LLM_MODEL)
 *   LLM_PROVIDER=openai         -> any OpenAI-compatible API    (OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL)
 *   LLM_PROVIDER=bedrock        -> Amazon Bedrock Runtime API   (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, LLM_MODEL)
 *
 * If the chosen provider has no API key/credentials, getProvider() returns null and the app runs in clearly labelled demo mode.
 * API keys and AWS credentials are read from the environment on the server only and are never sent to the browser.
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  /** parsed arguments; undefined plus parseError when the model produced invalid JSON */
  arguments?: unknown;
  parseError?: string;
}
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}
export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  kind: "network" | "auth" | "rate_limit" | "bad_response" | "timeout";
  constructor(kind: ProviderError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new ProviderError("timeout", `The AI provider did not respond within ${Math.round(TIMEOUT_MS / 1000)}s.`);
    throw new ProviderError("network", `Could not reach the AI provider (${e.cause ? String((e.cause as Error).message ?? e.cause) : e.message}).`);
  }
  const raw = await res.text();
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.parse(raw)?.error?.message ?? ""; } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new ProviderError("auth", `The AI provider rejected the API key (HTTP ${res.status}). Check the key in your server environment.`);
    if (res.status === 429) throw new ProviderError("rate_limit", "The AI provider is rate limiting requests (HTTP 429). Try again shortly.");
    throw new ProviderError("bad_response", `The AI provider returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError("bad_response", "The AI provider returned a response that was not valid JSON.");
  }
}

function parseArgs(raw: unknown): { arguments?: unknown; parseError?: string } {
  if (raw && typeof raw === "object") return { arguments: raw };
  if (typeof raw !== "string" || raw.trim() === "") return { arguments: {} };
  try {
    return { arguments: JSON.parse(raw) };
  } catch {
    return { parseError: "Tool arguments were not valid JSON." };
  }
}

// ------------------------------------------------------------------ OpenAI-compatible

class OpenAICompatible implements LLMProvider {
  readonly name = "openai";
  readonly model: string;
  private key: string;
  private base: string;
  constructor(key: string, model: string, base: string) {
    this.key = key;
    this.model = model;
    this.base = base.replace(/\/+$/, "");
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: any[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        messages.push({
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) }
            : {}),
        });
      } else messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
    const data = await postJson(`${this.base}/chat/completions`, { authorization: `Bearer ${this.key}` }, {
      model: this.model,
      messages,
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    });
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new ProviderError("bad_response", "The AI provider's response contained no message.");
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: String(c.id), name: String(c.function?.name ?? ""), ...parseArgs(c.function?.arguments) })),
    };
  }
}

// ------------------------------------------------------------------ Anthropic

class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private key: string;
  private base: string;
  constructor(key: string, model: string, base: string) {
    this.key = key;
    this.model = model;
    this.base = base.replace(/\/+$/, "");
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: any[] = [];
    const push = (role: "user" | "assistant", content: any[]) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...content);
      else messages.push({ role, content });
    };
    for (const m of req.messages) {
      if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
      else if (m.role === "assistant") {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
        if (blocks.length) push("assistant", blocks);
      } else push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
    }
    const data = await postJson(`${this.base}/v1/messages`, { "x-api-key": this.key, "anthropic-version": "2023-06-01" }, {
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      messages,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    });
    if (!Array.isArray(data?.content)) throw new ProviderError("bad_response", "The AI provider's response contained no content.");
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const b of data.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: String(b.id), name: String(b.name), arguments: b.input ?? {} });
    }
    return { text, toolCalls };
  }
}

// ------------------------------------------------------------------ Amazon Bedrock

class AwsBedrockProvider implements LLMProvider {
  readonly name = "bedrock";
  readonly model: string;
  private client: BedrockRuntimeClient;

  constructor(region: string, model: string) {
    this.model = model;
    this.client = new BedrockRuntimeClient({ region });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: any[] = [];
    for (const m of req.messages) {
      if (m.role === "user") {
        messages.push({ role: "user", content: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        const content: any[] = [];
        if (m.content) content.push({ text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments ?? {} } });
        }
        messages.push({ role: "assistant", content });
      } else if (m.role === "tool") {
        messages.push({
          role: "user",
          content: [{ toolResult: { toolUseId: m.toolCallId, content: [{ json: { result: m.content } }] } }]
        });
      }
    }

    const command = new ConverseCommand({
      modelId: this.model,
      system: [{ text: req.system }],
      messages,
      toolConfig: {
        tools: req.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.parameters }
          }
        }))
      }
    });

    try {
      const response = await this.client.send(command);
      const outputMsg = response.output?.message;
      let text = "";
      const toolCalls: ToolCall[] = [];

      for (const block of outputMsg?.content ?? []) {
        if (block.text) text += block.text;
        if (block.toolUse) {
          toolCalls.push({
            id: block.toolUse.toolUseId!,
            name: block.toolUse.name!,
            arguments: block.toolUse.input ?? {}
          });
        }
      }

      return { text, toolCalls };
    } catch (err) {
      const e = err as Error;
      if (e.name === "UnauthorizedException" || e.name === "AccessDeniedException" || e.name === "UnrecognizedClientException") {
        throw new ProviderError("auth", `The AI provider rejected the API key (${e.message}).`);
      }
      if (e.name === "ThrottlingException") {
        throw new ProviderError("rate_limit", "AWS Bedrock rate limit exceeded.");
      }
      throw new ProviderError("bad_response", `AWS Bedrock error: ${e.message}`);
    }
  }
}

// ------------------------------------------------------------------ selection

export interface ProviderStatus {
  mode: "live" | "demo";
  provider: string | null;
  model: string | null;
  reason: string;
}

export function providerStatus(env = process.env): ProviderStatus {
  const which = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  if (which === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return { mode: "demo", provider: null, model: null, reason: "ANTHROPIC_API_KEY is not set" };
    return { mode: "live", provider: "anthropic", model: env.LLM_MODEL || "claude-sonnet-5-5", reason: "configured" };
  }
  if (which === "openai") {
    if (!env.OPENAI_API_KEY) return { mode: "demo", provider: null, model: null, reason: "OPENAI_API_KEY is not set" };
    if (!env.LLM_MODEL) return { mode: "demo", provider: null, model: null, reason: "LLM_MODEL is not set (required for the openai-compatible provider)" };
    return { mode: "live", provider: "openai", model: env.LLM_MODEL, reason: "configured" };
  }
  if (which === "bedrock") {
    if (!env.AWS_REGION) return { mode: "demo", provider: null, model: null, reason: "AWS_REGION is not set for bedrock" };
    return { mode: "live", provider: "bedrock", model: env.LLM_MODEL || "anthropic.claude-3-5-sonnet-20241022-v1:0", reason: "configured" };
  }
  return { mode: "demo", provider: null, model: null, reason: `Unknown LLM_PROVIDER "${which}" (use anthropic, openai, or bedrock)` };
}

export function getProvider(env = process.env): LLMProvider | null {
  const s = providerStatus(env);
  if (s.mode === "demo") return null;
  if (s.provider === "anthropic") return new AnthropicProvider(env.ANTHROPIC_API_KEY!, s.model!, env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  if (s.provider === "openai") return new OpenAICompatible(env.OPENAI_API_KEY!, s.model!, env.OPENAI_BASE_URL || "https://api.openai.com/v1");
  if (s.provider === "bedrock") return new AwsBedrockProvider(env.AWS_REGION!, s.model!);
  return null;
}