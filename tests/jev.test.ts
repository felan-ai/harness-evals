import { expect, test } from 'bun:test';
import { createJevJudgeRunner } from '../src/judge/jev.js';
import type { JudgeRequest } from '../src/judge/types.js';

const request: JudgeRequest = {
  judgeType: 'jevJudge',
  provider: 'typesafe',
  rubric: 'Is the result acceptable?',
  threshold: 0.8,
  inputs: { finalOutput: 'done' },
  prompt: 'unused by Jev',
};

test('Jev runner uses pinned provider transports and normalizes probability', async () => {
  const cases = [
    ['typesafe', 'https://api.typesafe.ai/v1/systemone', 'jev-latest', 'TYPESAFE_API_KEY'],
    ['openrouter', 'https://openrouter.ai/api/v1/systemone', 'typesafe/jev-1.13', 'OPENROUTER_API_KEY'],
    ['vercel-ai-gateway', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'typesafe-ai/jev', 'AI_GATEWAY_API_KEY'],
  ] as const;

  for (const [provider, url, model, envName] of cases) {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const runner = createJevJudgeRunner({
      environment: { [envName]: 'secret-key' },
      fetch: async (input, init) => {
        seenUrl = input.href;
        seenInit = init;
        return new Response(JSON.stringify({
          answers: { score: { type: 'noul', noul: 0.92, confidence: 0.87 } },
          usage: { input_tokens: 11, output_tokens: 3 },
          provider_metadata: { gateway: { cost: '0.0002' } },
        }), { status: 200 });
      },
    });
    const result = await runner({ ...request, provider });
    const body = JSON.parse(String(seenInit?.body)) as { model: string; state: unknown; questions: Record<string, unknown> };
    expect(seenUrl).toBe(url);
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    expect(body.model).toBe(model);
    expect(body.state).toEqual({ finalOutput: 'done' });
    expect(body.questions.score).toEqual({ type: 'noul', instructions: request.rubric });
    expect(result).toMatchObject({
      score: 0.92,
      reason: 'Jev probability of satisfying the rubric: 0.92',
      metadata: { provider, model, confidence: 0.87, usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, totalCost: 0.0002 } },
    });
  }
});

test('Jev runner rejects missing credentials and invalid responses without leaking credentials', async () => {
  const runner = createJevJudgeRunner({
    environment: { TYPESAFE_API_KEY: 'secret-key' },
    fetch: async () => new Response('Bearer secret-key is not valid', { status: 401 }),
  });
  await expect(runner(request)).rejects.toThrow(/\[redacted\]/);
  await expect(runner({ ...request, provider: 'openrouter' })).rejects.toThrow('Jev credential env OPENROUTER_API_KEY is not set');

  const invalidRunner = createJevJudgeRunner({
    environment: { TYPESAFE_API_KEY: 'secret-key' },
    fetch: async () => new Response(JSON.stringify({ answers: { score: { noul: 2 } } }), { status: 200 }),
  });
  await expect(invalidRunner(request)).rejects.toThrow('missing a valid score');
});

test('Jev runner enforces request and timeout budgets', async () => {
  const oversized = createJevJudgeRunner({ environment: { TYPESAFE_API_KEY: 'secret-key' }, fetch: async () => new Response('{}') });
  await expect(oversized({ ...request, inputs: { output: 'x'.repeat(70 * 1024) } })).rejects.toThrow('state exceeds');

  const timeout = createJevJudgeRunner({
    timeoutMs: 1,
    environment: { TYPESAFE_API_KEY: 'secret-key' },
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  await expect(timeout(request)).rejects.toThrow('timed out');
});
