import type { PublicBatchManifest, PublicRunSummary } from './types.js';

const COLUMNS = [
  'runId', 'caseId', 'agentName', 'agentLabel', 'comparisonId', 'suite', 'attemptNumber', 'attempts', 'status', 'startedAt',
  'durationMs', 'exitCode', 'score', 'assertionPassRate', 'judgeScore', 'verifierReward', 'provider', 'model', 'models', 'totalAssertions', 'passedAssertions',
  'failedRequired', 'totalCost', 'currency', 'inputTokens', 'outputTokens', 'cachedInputTokens',
  'reasoningTokens', 'totalTokens', 'requests', 'thinking', 'packageVersion',
] as const;

export function renderPublicBatchCsv(manifest: PublicBatchManifest): string {
  const rows = [COLUMNS.map(csvCell).join(',')];
  for (const run of manifest.runs) rows.push(COLUMNS.map((column) => csvCell(runValue(run, column))).join(','));
  return `${rows.join('\n')}\n`;
}

type Column = typeof COLUMNS[number];

function runValue(run: PublicRunSummary, column: Column): string | number | boolean | null | undefined {
  switch (column) {
    case 'totalAssertions': return run.assertions?.total;
    case 'passedAssertions': return run.assertions?.passed;
    case 'failedRequired': return run.assertions?.failedRequired;
    case 'totalCost': return run.cost?.totalCost;
    case 'currency': return run.cost?.currency;
    case 'inputTokens': return run.cost?.inputTokens;
    case 'outputTokens': return run.cost?.outputTokens;
    case 'cachedInputTokens': return run.cost?.cachedInputTokens;
    case 'reasoningTokens': return run.cost?.reasoningTokens;
    case 'totalTokens': return run.cost?.totalTokens;
    case 'requests': return run.cost?.requests;
    case 'models': return run.models?.join('|');
    case 'runId': return run.runId;
    case 'caseId': return run.caseId;
    case 'agentName': return run.agentName;
    case 'agentLabel': return run.agentLabel;
    case 'comparisonId': return run.comparisonId ?? run.agentName;
    case 'suite': return run.suite;
    case 'attemptNumber': return run.attemptNumber;
    case 'attempts': return run.attempts;
    case 'status': return run.status;
    case 'startedAt': return run.startedAt;
    case 'durationMs': return run.durationMs;
    case 'exitCode': return run.exitCode;
    case 'score': return run.score;
    case 'assertionPassRate': return run.assertionPassRate;
    case 'judgeScore': return run.judgeScore;
    case 'verifierReward': return run.verifierReward;
    case 'provider': return run.provider;
    case 'model': return run.model;
    case 'thinking': return run.thinking;
    case 'packageVersion': return run.packageVersion;
  }
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === undefined) return '';
  const text = value === null ? 'null' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
