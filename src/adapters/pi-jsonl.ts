import type { AgentEventsSummary, CostReport, ToolCallSummary, UsageReport } from '../events/types.js';
import { stdoutLines } from './stdout-lines.js';
import type { AgentEventInput } from './types.js';

interface MutableToolCall extends ToolCallSummary {
  id?: string;
}

export async function parsePiJsonlEvents(
  input: Pick<AgentEventInput, 'stdout' | 'stdoutPath'>,
): Promise<AgentEventsSummary> {
  const errors: string[] = [];
  const toolCalls: MutableToolCall[] = [];
  const toolCallsById = new Map<string, MutableToolCall>();
  const usageByModel = new Map<string, UsageReport>();
  let costSeen = false;
  let finalOutput = '';
  let index = 0;
  let parseErrors = 0;

  for await (const rawLine of stdoutLines(input)) {
    const line = rawLine.trim();
    if (!line) continue;
    index += 1;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      event = parsed;
    } catch (error) {
      parseErrors += 1;
      if (parseErrors <= MAX_PARSE_ERRORS) errors.push(`Line ${index}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const type = event.type;
    if (type === 'tool_execution_start') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      const name = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      const call: MutableToolCall = { id, name, args: event.args };
      toolCalls.push(call);
      if (id) toolCallsById.set(id, call);
      continue;
    }

    if (type === 'tool_execution_end') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      const name = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      const call = (id ? toolCallsById.get(id) : undefined) ?? createToolCall(toolCalls, toolCallsById, id, name);
      call.result = capToolResult(event.result);
      call.isError = Boolean(event.isError);
      if (call.isError) errors.push(`Tool ${name} failed`);
      continue;
    }

    if (type === 'message_end' || type === 'turn_end') {
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === 'assistant') {
        finalOutput = extractMessageText(message);
        collectMessageError(message, errors);
        // Usage is accumulated from message_end only: turn_end repeats the turn's
        // final assistant message and would double-count it.
        if (type === 'message_end' && accumulateMessageUsage(message, usageByModel)) costSeen = true;
      }
      continue;
    }

    if (type === 'agent_end' && Array.isArray(event.messages)) {
      const assistant = [...event.messages]
        .reverse()
        .find((message): message is Record<string, unknown> => isRecord(message) && message.role === 'assistant');
      if (assistant) {
        finalOutput = extractMessageText(assistant);
        collectMessageError(assistant, errors);
      }
    }
  }

  if (!finalOutput) {
    // Heuristic fallback for non-pi JSONL; the in-memory tail is enough here.
    const genericJson = parseJsonl(input.stdout);
    const final = [...genericJson].reverse().find((event) => typeof event.output === 'string' || typeof event.text === 'string');
    finalOutput = typeof final?.output === 'string' ? final.output : typeof final?.text === 'string' ? final.text : '';
  }

  return {
    finalOutput,
    toolCalls: toolCalls.map(({ id: _id, ...call }) => call),
    errors,
    cost: piCostReport(usageByModel, costSeen),
  };
}

const MAX_PARSE_ERRORS = 50;
const TOOL_RESULT_PREVIEW_CHARS = 4096;

// Tool results can embed whole files; retaining them across hundreds of calls
// (and serializing them into events-summary/result artifacts) balloons memory.
function capToolResult(result: unknown): unknown {
  if (typeof result === 'string') {
    return capSerializedToolResult(result);
  }
  if (result && typeof result === 'object') {
    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized.length > TOOL_RESULT_PREVIEW_CHARS) return capSerializedToolResult(serialized);
    } catch {
      return '[unserializable tool result]';
    }
  }
  return result;
}

function capSerializedToolResult(result: string): string {
  if (result.length <= TOOL_RESULT_PREVIEW_CHARS) return result;
  // Keep the established head preview while retaining appended diagnostics and errors.
  const tailChars = Math.floor(TOOL_RESULT_PREVIEW_CHARS / 2);
  return `${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}… [truncated] …${result.slice(-tailChars)}`;
}

// Assistant message_end events carry per-message usage:
// { input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }.
function accumulateMessageUsage(message: Record<string, unknown>, usageByModel: Map<string, UsageReport>): boolean {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  if (!usage) return false;
  const provider = typeof message.provider === 'string' ? message.provider : 'pi';
  const model = typeof message.model === 'string' ? message.model : 'unknown';
  const key = `${provider}${model}`;
  const entry = usageByModel.get(key) ?? { provider, model, requests: 0 };
  const inputTokens = numberOrZero(usage.input);
  const cacheReadInputTokens = numberOrZero(usage.cacheRead);
  const cacheWriteInputTokens = numberOrZero(usage.cacheWrite);
  entry.inputTokens = (entry.inputTokens ?? 0) + inputTokens;
  entry.promptTokens = (entry.promptTokens ?? 0) + inputTokens + cacheReadInputTokens + cacheWriteInputTokens;
  entry.uncachedInputTokens = (entry.uncachedInputTokens ?? 0) + inputTokens;
  entry.cacheReadInputTokens = (entry.cacheReadInputTokens ?? 0) + cacheReadInputTokens;
  entry.cacheWriteInputTokens = (entry.cacheWriteInputTokens ?? 0) + cacheWriteInputTokens;
  entry.outputTokens = (entry.outputTokens ?? 0) + numberOrZero(usage.output);
  entry.cachedInputTokens = (entry.cachedInputTokens ?? 0) + cacheReadInputTokens;
  entry.totalTokens = (entry.totalTokens ?? 0)
    + (numberOrUndefined(usage.totalTokens)
      ?? numberOrZero(usage.input) + numberOrZero(usage.output) + numberOrZero(usage.cacheRead) + numberOrZero(usage.cacheWrite));
  entry.requests = (entry.requests ?? 0) + 1;
  const cost = isRecord(usage.cost) ? numberOrUndefined(usage.cost.total) : undefined;
  if (cost !== undefined) {
    entry.totalCost = (entry.totalCost ?? 0) + cost;
    entry.currency = 'USD';
  }
  usageByModel.set(key, entry);
  return true;
}

function piCostReport(usageByModel: Map<string, UsageReport>, costSeen: boolean): CostReport | undefined {
  if (!costSeen || usageByModel.size === 0) return undefined;
  const usage = [...usageByModel.values()];
  const totalCost = usage.reduce<number | undefined>(
    (total, entry) => (entry.totalCost === undefined ? total : (total ?? 0) + entry.totalCost),
    undefined,
  );
  return {
    available: true,
    currency: totalCost === undefined ? undefined : 'USD',
    totalCost,
    usage,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonl(input: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
    }
  }

  return events;
}

function createToolCall(
  toolCalls: MutableToolCall[],
  toolCallsById: Map<string, MutableToolCall>,
  id: string | undefined,
  name: string,
): MutableToolCall {
  const call: MutableToolCall = { id, name };
  toolCalls.push(call);
  if (id) toolCallsById.set(id, call);
  return call;
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function collectMessageError(message: Record<string, unknown>, errors: string[]): void {
  const stopReason = message.stopReason;
  if ((stopReason === 'error' || stopReason === 'aborted') && typeof message.errorMessage === 'string') {
    errors.push(message.errorMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
