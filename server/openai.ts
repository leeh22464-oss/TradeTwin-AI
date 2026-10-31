/**
 * Small, server-only adapter for the official OpenAI Responses API.
 *
 * The adapter deliberately keeps the endpoint fixed.  An OPENAI_API_KEY can
 * never be redirected through LLM_BASE_URL; an LLM key is accepted for the
 * official API only when its base URL is exactly the official API base.
 */

export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_RESPONSES_URL = `${OPENAI_API_BASE_URL}/responses`;
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1';

export type FetchLike = typeof fetch;

export interface OfficialOpenAIConfig {
  apiKey: string;
  model: string;
  baseUrl: typeof OPENAI_API_BASE_URL;
}

export interface LegacyModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ResponsesCallOptions {
  apiKey?: string;
  model?: string;
  input: unknown;
  textFormat?: { type: 'json_object' } | { type: 'text' };
  tools?: unknown[];
  toolChoice?: unknown;
  include?: string[];
  maxOutputTokens?: number;
  store?: boolean;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalize only the path/trailing slash; no host aliases are accepted. */
export function normalizeOfficialBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function isOfficialBaseUrl(value: string): boolean {
  return normalizeOfficialBaseUrl(value) === OPENAI_API_BASE_URL;
}

/**
 * Resolve official credentials. OPENAI_API_KEY always wins. LLM_API_KEY is a
 * compatibility alias only for an exact official LLM_BASE_URL.
 */
export function getOfficialConfig(env: NodeJS.ProcessEnv = process.env): OfficialOpenAIConfig | null {
  const explicitKey = envValue('OPENAI_API_KEY', env);
  const legacyKey = envValue('LLM_API_KEY', env);
  const legacyBase = envValue('LLM_BASE_URL', env);
  const apiKey = explicitKey || (legacyKey && isOfficialBaseUrl(legacyBase) ? legacyKey : '');
  if (!apiKey) return null;
  return {
    apiKey,
    // An explicit OPENAI_API_KEY uses the official model setting and defaults
    // independently of any legacy provider's LLM_MODEL value. The legacy
    // model remains a compatibility fallback when LLM_* is the credential.
    model: envValue('OPENAI_MODEL', env)
      || (explicitKey ? DEFAULT_OPENAI_MODEL : envValue('LLM_MODEL', env) || DEFAULT_OPENAI_MODEL),
    baseUrl: OPENAI_API_BASE_URL,
  };
}

/** Resolve the old OpenAI-compatible chat/completions configuration. */
export function getLegacyConfig(env: NodeJS.ProcessEnv = process.env): LegacyModelConfig | null {
  const baseUrl = normalizeOfficialBaseUrl(envValue('LLM_BASE_URL', env));
  const apiKey = envValue('LLM_API_KEY', env);
  const model = envValue('LLM_MODEL', env);
  // Exact official configuration is owned by the Responses adapter.
  if (!baseUrl || !apiKey || !model || isOfficialBaseUrl(baseUrl)) return null;
  return { baseUrl, apiKey, model };
}

export function modelConfiguration(env: NodeJS.ProcessEnv = process.env): {
  official: OfficialOpenAIConfig | null;
  legacy: LegacyModelConfig | null;
} {
  return { official: getOfficialConfig(env), legacy: getLegacyConfig(env) };
}

function extractResponseText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string' && record.output_text.trim()) return record.output_text.trim();
  const output = record.output;
  if (!Array.isArray(output)) return null;
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) chunks.push(text);
    }
  }
  return chunks.length ? chunks.join('') : null;
}

/**
 * Call the fixed official Responses endpoint. This function is intentionally
 * transport-focused; callers validate output shape and domain-specific tool
 * events themselves.
 */
export async function callOpenAIResponses(options: ResponsesCallOptions): Promise<{ payload: unknown; text: string | null }> {
  const config = getOfficialConfig();
  const apiKey = options.apiKey?.trim() || config?.apiKey || '';
  const model = options.model?.trim() || config?.model || DEFAULT_OPENAI_MODEL;
  if (!apiKey) throw new Error('OPENAI_API_KEY 未配置');
  const body: Record<string, unknown> = {
    model,
    input: options.input,
    store: options.store ?? false,
  };
  if (options.textFormat) body.text = { format: options.textFormat };
  if (options.tools) body.tools = options.tools;
  if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  if (options.include?.length) body.include = options.include;
  if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`OpenAI Responses 返回 HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  return { payload, text: extractResponseText(payload) };
}

export function responseText(payload: unknown): string | null {
  return extractResponseText(payload);
}
