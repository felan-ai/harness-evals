import type { JevProvider } from '../config/schema.js';
import type { JudgeRequest, JudgeResult, JudgeRunner } from './types.js';

type JevFetch = (input: URL, init: RequestInit) => Promise<Response>;

interface JevTransport {
  provider: JevProvider;
  url: URL;
  model: string;
  apiKey: string;
}

interface JevAnswer {
  noul?: unknown;
  confidence?: unknown;
}

interface JevResponse {
  answers?: Record<string, JevAnswer>;
  usage?: Record<string, unknown>;
  provider_metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface JevJudgeRunnerOptions {
  fetch?: JevFetch;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const INVALID_CREDENTIAL = /[\0-\x1f\x7f]/u;
const TRANSPORTS: Record<JevProvider, { url: string; model: string; env: string }> = {
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', env: 'TYPESAFE_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', env: 'OPENROUTER_API_KEY' },
  'vercel-ai-gateway': { url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', env: 'AI_GATEWAY_API_KEY' },
};
const PINNED_HOSTS = new Set(['api.typesafe.ai', 'openrouter.ai', 'ai-gateway.vercel.sh']);

export const defaultJevJudgeRunner: JudgeRunner = createJevJudgeRunner();

export function createJevJudgeRunner(options: JevJudgeRunnerOptions = {}): JudgeRunner {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const environment = options.environment ?? process.env;
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  return async (request) => {
    const provider = readProvider(request.provider);
    const transportConfig = TRANSPORTS[provider];
    const apiKeyEnv = request.apiKeyEnv ?? transportConfig.env;
    const apiKey = normalizeCredential(environment[apiKeyEnv]);
    if (!apiKey) throw new Error(`Jev credential env ${apiKeyEnv} is not set`);
    const transport: JevTransport = {
      provider,
      url: new URL(transportConfig.url),
      model: request.model ?? transportConfig.model,
      apiKey,
    };
    const requestTimeoutMs = request.timeoutMs === undefined ? timeoutMs : normalizeTimeout(request.timeoutMs);
    return evaluate(transport, request, fetcher, requestTimeoutMs);
  };
}

async function evaluate(
  transport: JevTransport,
  request: JudgeRequest,
  fetcher: JevFetch,
  timeoutMs: number,
): Promise<JudgeResult> {
  if (transport.url.protocol !== 'https:' || !PINNED_HOSTS.has(transport.url.hostname)) {
    throw new Error('Jev endpoint is not pinned');
  }
  const state = request.inputs;
  const stateJson = JSON.stringify(state);
  if (Buffer.byteLength(stateJson, 'utf8') > MAX_STATE_BYTES) throw new Error('Jev state exceeds the size budget');
  const body = JSON.stringify({
    model: transport.model,
    state,
    questions: {
      score: { type: 'noul', instructions: request.rubric },
    },
  });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Jev request exceeds the size budget');

  const controller = createTimeout(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(transport.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${transport.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    controller.dispose();
    if (controller.timedOut) throw new Error('Jev request timed out');
    throw new Error(sanitizeError('Jev request failed', error, transport.apiKey));
  }

  let text: string;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Jev response exceeds the size budget');
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    controller.dispose();
    if (controller.timedOut) throw new Error('Jev request timed out');
    throw new Error(sanitizeError('Jev response could not be read', error, transport.apiKey));
  } finally {
    controller.dispose();
  }
  if (!response.ok) throw new Error(sanitizeError(`Jev request failed (${response.status})`, text.slice(0, 200), transport.apiKey));

  const parsed = parseResponse(text, transport, request);
  return parsed;
}

function parseResponse(text: string, transport: JevTransport, request: JudgeRequest): JudgeResult {
  let parsed: JevResponse;
  try {
    parsed = JSON.parse(text) as JevResponse;
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  const answer = parsed.answers?.score;
  const score = unitNumber(answer?.noul);
  if (score === undefined) throw new Error('Jev response is missing a valid score answer');
  const confidence = answer && unitNumber(answer.confidence);
  const usage = normalizeUsage(parsed, transport, request);
  return {
    score,
    reason: `Jev probability of satisfying the rubric: ${score}`,
    metadata: {
      provider: transport.provider,
      model: transport.model,
      ...(confidence === undefined ? {} : { confidence }),
      ...(usage === undefined ? {} : { usage }),
      response: parsed.provider_metadata ?? parsed.providerMetadata,
    },
  };
}

function normalizeUsage(parsed: JevResponse, transport: JevTransport, request: JudgeRequest): Record<string, unknown> | undefined {
  const usage = parsed.usage;
  const gateway = readRecord(readRecord(parsed.provider_metadata)?.gateway ?? readRecord(parsed.providerMetadata)?.gateway);
  const inputTokens = nonNegativeNumber(usage?.input_tokens) ?? nonNegativeNumber(usage?.inputTokens);
  const outputTokens = nonNegativeNumber(usage?.output_tokens) ?? nonNegativeNumber(usage?.outputTokens);
  const totalCost = nonNegativeNumber(usage?.cost)
    ?? nonNegativeNumber(usage?.totalCost)
    ?? nonNegativeNumber(gateway?.cost);
  if (inputTokens === undefined && outputTokens === undefined && totalCost === undefined) return undefined;
  return {
    provider: transport.provider,
    model: transport.model,
    inputTokens,
    outputTokens,
    totalTokens: sumDefined([inputTokens, outputTokens]),
    totalCost,
    requests: 1,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
}

function readProvider(value: string | undefined): JevProvider {
  if (value === 'typesafe' || value === 'openrouter' || value === 'vercel-ai-gateway') return value;
  throw new Error('jevJudge requires judge.provider: typesafe, openrouter, or vercel-ai-gateway');
}

function normalizeCredential(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_CREDENTIAL_BYTES || INVALID_CREDENTIAL.test(trimmed)) throw new Error('Jev API key is invalid');
  return trimmed;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) throw new Error('Jev timeout is invalid');
  return value;
}

function createTimeout(timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return { signal: controller.signal, get timedOut() { return timedOut; }, dispose: () => clearTimeout(timer) };
}

function sanitizeError(prefix: string, detail: unknown, credential: string): string {
  const raw = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  return `${prefix}${raw ? `: ${raw}` : ''}`
    .split(credential).join('[redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 300);
}

function unitNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
