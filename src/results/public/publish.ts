import type { BenchmarkDefinition, ResultsPublishConfig } from '../../config/schema.js';
import { readLocalBatchRecord } from '../../runner/batch-record.js';
import { scanWorkspaceRuns } from '../../visualization/scan.js';
import { FilePublicResultsStore } from './stores/file.js';
import { projectPublicBatch } from './project.js';
import { renderPublicBatchCsv } from './render-csv.js';
import { renderPublicBatchHtml, renderPublicIndexHtml } from './render-html.js';
import type { PublicBatchIndexEntry, PublicBatchValidity, PublicResultsIndex, PublicResultsStore } from './types.js';
import { validatePublicObjectKey } from './stores/keys.js';
import { analyzeBenchmark } from '../../benchmarks/analyze.js';
import { renderBenchmarkCsv, renderBenchmarkHtml, renderBenchmarkJson } from '../../benchmarks/render.js';
import { filterBenchmarkRuns } from '../../benchmarks/select.js';

const enc = new TextEncoder();
const text = new TextDecoder();
const immutableCache = 'public, max-age=31536000, immutable';

export interface PublishOptions {
  projectRoot: string;
  artifactRoot: string;
  config: ResultsPublishConfig;
  batchId: string;
  store?: PublicResultsStore;
  dryRun?: boolean;
  validity?: PublicBatchValidity;
  validityNote?: string;
  supersededBy?: string;
  allowUnfinalized?: boolean;
  benchmarks?: Record<string, BenchmarkDefinition>;
  benchmarkCases?: Record<string, string[]>;
}

export interface PublishResult {
  batchId: string;
  reportUrl?: string;
  dryRun: boolean;
  entry: PublicBatchIndexEntry;
}

export interface PublishStatusOptions {
  config: ResultsPublishConfig;
  batchId: string;
  validity: PublicBatchValidity;
  validityNote?: string;
  supersededBy?: string;
  store?: PublicResultsStore;
  dryRun?: boolean;
}

export async function publishBatch(options: PublishOptions): Promise<PublishResult> {
  validatePublicObjectKey(options.batchId);
  if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(options.batchId)) throw new Error(`Invalid batch ID: ${options.batchId}`);
  validateValidity(options.validity, options.validityNote, options.supersededBy, options.allowUnfinalized === true);
  const scan = await scanWorkspaceRuns({ artifactRoot: options.artifactRoot });
  const batch = scan.batches.find((candidate) => candidate.batchId === options.batchId);
  const runs = scan.taskRuns.filter((run) => run.batchId === options.batchId);
  if (!batch || runs.length === 0) throw new Error(`Unknown or empty batch: ${options.batchId}`);
  const record = await readLocalBatchRecord(options.projectRoot, options.batchId);
  validateFinalization(record, options.batchId, runs, options.allowUnfinalized === true);
  const manifest = projectPublicBatch(batch, runs);
  const root = `${options.config.prefix}/v1`;
  const paths = {
    manifest: `${root}/batches/${options.batchId}/manifest.json`,
    html: `${root}/batches/${options.batchId}/results.html`,
    csv: `${root}/batches/${options.batchId}/results.csv`,
    index: `${root}/index.json`,
    indexHtml: `${root}/index.html`,
  };
  Object.values(paths).forEach((path) => validatePublicObjectKey(path));
  const bytes = {
    manifest: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    html: enc.encode(renderPublicBatchHtml(manifest)),
    csv: enc.encode(renderPublicBatchCsv(manifest)),
  };
  const benchmarkObjects = Object.entries(options.benchmarks ?? {}).flatMap(([id, definition]) => {
    const selectedRuns = filterBenchmarkRuns(runs.filter((run) =>
      (definition.select.cases?.includes(run.caseId) || (run.suite && definition.select.suites?.includes(run.suite)))
      && [definition.arms.baseline, definition.arms.candidate].includes(run.agentName)), id, definition);
    const configuredCases = options.benchmarkCases?.[id];
    if (configuredCases?.some((caseId) => typeof caseId !== 'string' || caseId.length === 0)) {
      throw new Error(`benchmarkCases.${id} must contain non-empty case IDs`);
    }
    if (definition.select.suites?.length && !configuredCases?.length) {
      throw new Error(`benchmarkCases.${id} must contain the cases selected by suite`);
    }
    const selectedCases = [...new Set([
      ...(configuredCases ?? []),
      ...(definition.select.cases ?? []),
      ...selectedRuns.map((run) => run.caseId),
    ])].sort();
    if (selectedCases.length === 0) return [];
    const report = analyzeBenchmark({ id, definition, runs: selectedRuns, cases: selectedCases });
    const base = `${root}/batches/${options.batchId}/benchmarks/${id}`;
    const paths = { json: `${base}/results.json`, html: `${base}/results.html`, csv: `${base}/results.csv` };
    Object.values(paths).forEach((path) => validatePublicObjectKey(path));
    return [{ id, report, paths }];
  });
  const store = options.store ?? createConfiguredStore(options.config);
  const old = await readIndex(store, paths.index);
  const previous = old.batches.find((entry) => entry.batchId === options.batchId);
  const entry: PublicBatchIndexEntry = {
    batchId: options.batchId,
    ...(manifest.startedAt ? { startedAt: manifest.startedAt } : {}),
    ...(manifest.label ? { label: manifest.label } : {}),
    validity: options.validity ?? previous?.validity ?? (options.allowUnfinalized ? 'invalid' : 'valid'),
    ...(options.validityNote !== undefined ? { validityNote: options.validityNote } : previous?.validityNote !== undefined ? { validityNote: previous.validityNote } : {}),
    ...(options.supersededBy !== undefined ? { supersededBy: options.supersededBy } : previous?.supersededBy !== undefined ? { supersededBy: previous.supersededBy } : {}),
    suites: manifest.suites, cases: manifest.cases, agents: manifest.agents, totals: manifest.totals,
    manifestPath: `batches/${options.batchId}/manifest.json`, reportPath: `batches/${options.batchId}/results.html`, csvPath: `batches/${options.batchId}/results.csv`,
    ...(benchmarkObjects.length > 0 ? { benchmarkPaths: Object.fromEntries(benchmarkObjects.map((item) => [item.id, { jsonPath: item.paths.json.slice(`${root}/`.length), reportPath: item.paths.html.slice(`${root}/`.length), csvPath: item.paths.csv.slice(`${root}/`.length) }])) } : {}),
  };
  if (options.dryRun) return { batchId: options.batchId, dryRun: true, entry };
  await putImmutable(store, paths.manifest, bytes.manifest, 'application/json; charset=utf-8');
  await putImmutable(store, paths.html, bytes.html, 'text/html; charset=utf-8');
  await putImmutable(store, paths.csv, bytes.csv, 'text/csv; charset=utf-8');
  for (const item of benchmarkObjects) {
    await putImmutable(store, item.paths.json, enc.encode(renderBenchmarkJson(item.report)), 'application/json; charset=utf-8');
    await putImmutable(store, item.paths.html, enc.encode(renderBenchmarkHtml(item.report)), 'text/html; charset=utf-8');
    await putImmutable(store, item.paths.csv, enc.encode(renderBenchmarkCsv(item.report)), 'text/csv; charset=utf-8');
  }
  const benchmarkEntries = benchmarkObjects.map((item) => ({ id: item.id, label: item.report.definition.label, batchId: options.batchId, jsonPath: item.paths.json.slice(`${options.config.prefix}/v1/`.length), reportPath: item.paths.html.slice(`${options.config.prefix}/v1/`.length), csvPath: item.paths.csv.slice(`${options.config.prefix}/v1/`.length) }));
  const next: PublicResultsIndex = sortIndex({ schemaVersion: 1, updatedAt: new Date().toISOString(), batches: [...old.batches.filter((item) => item.batchId !== options.batchId), entry], ...(benchmarkEntries.length > 0 ? { benchmarks: [...(old.benchmarks ?? []).filter((item) => item.batchId !== options.batchId), ...benchmarkEntries] } : old.benchmarks ? { benchmarks: old.benchmarks } : {}) });
  await store.put(paths.indexHtml, enc.encode(renderPublicIndexHtml()), { contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' });
  await store.put(paths.index, enc.encode(`${JSON.stringify(next, null, 2)}\n`), { contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' });
  return { batchId: options.batchId, dryRun: false, entry, reportUrl: options.config.publicBaseUrl ? `${options.config.publicBaseUrl}/batches/${options.batchId}/results.html` : undefined };
}

export async function publishBatchStatus(input: PublishStatusOptions): Promise<void> {
  validateValidity(input.validity, input.validityNote, input.supersededBy, false);
  if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(input.batchId)) throw new Error(`Invalid batch ID: ${input.batchId}`);
  const store = input.store ?? createConfiguredStore(input.config);
  const indexPath = `${input.config.prefix}/v1/index.json`;
  validatePublicObjectKey(indexPath);
  const index = await readIndex(store, indexPath);
  const current = index.batches.find((entry) => entry.batchId === input.batchId);
  if (!current) throw new Error(`Published batch not found: ${input.batchId}`);
  const batches = index.batches.map((entry) => entry.batchId !== input.batchId ? entry : {
    ...entry,
    validity: input.validity,
    ...(input.validityNote !== undefined ? { validityNote: input.validityNote } : { validityNote: undefined }),
    ...(input.supersededBy !== undefined ? { supersededBy: input.supersededBy } : { supersededBy: undefined }),
  });
  if (input.dryRun) return;
  await store.put(indexPath, enc.encode(`${JSON.stringify(sortIndex({ ...index, updatedAt: new Date().toISOString(), batches }), null, 2)}\n`), { contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' });
}

function validateFinalization(record: Awaited<ReturnType<typeof readLocalBatchRecord>>, batchId: string, runs: readonly { runId: string }[], allow: boolean): void {
  if (!record) { if (!allow) throw new Error(`Batch lacks a completed local batch record: ${batchId}`); return; }
  const recordedRunIds = new Set(record.runIds);
  const scannedRunIds = new Set(runs.map((run) => run.runId));
  const exact = record.status === 'completed'
    && record.expectedRunCount === record.runIds.length
    && recordedRunIds.size === record.runIds.length
    && scannedRunIds.size === runs.length
    && recordedRunIds.size === scannedRunIds.size
    && [...recordedRunIds].every((id) => scannedRunIds.has(id));
  if (!exact && !allow) throw new Error(`Local batch record does not match scanned runs: ${batchId}`);
}
function validateValidity(validity: PublicBatchValidity | undefined, note: string | undefined, supersededBy: string | undefined, allow: boolean): void {
  if (validity && !['valid', 'invalid', 'superseded'].includes(validity)) throw new Error(`Invalid validity: ${validity}`);
  if (supersededBy !== undefined && validity !== 'superseded') throw new Error('--superseded-by requires superseded validity');
  if (supersededBy !== undefined && !/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(supersededBy)) throw new Error(`Invalid batch ID: ${supersededBy}`);
  if (allow && (validity !== 'invalid' || !note?.trim())) throw new Error('--allow-unfinalized requires invalid validity and a non-empty validity note');
}
async function putImmutable(store: PublicResultsStore, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const existing = await store.get(key); if (existing && !equal(existing, bytes)) throw new Error(`Immutable public result object already exists with different content: ${key}`);
  if (!existing) await store.put(key, bytes, { contentType, cacheControl: immutableCache });
}
async function readIndex(store: PublicResultsStore, key: string): Promise<PublicResultsIndex> { const bytes = await store.get(key); if (!bytes) return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), batches: [] }; const value = JSON.parse(text.decode(bytes)) as PublicResultsIndex; if (value.schemaVersion !== 1 || !Array.isArray(value.batches)) throw new Error('Invalid public results index'); return value; }
function sortIndex(index: PublicResultsIndex): PublicResultsIndex { return { ...index, batches: [...index.batches].sort((a, b) => (b.startedAt ?? b.batchId).localeCompare(a.startedAt ?? a.batchId) || b.batchId.localeCompare(a.batchId)) }; }
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]); }
function createConfiguredStore(config: ResultsPublishConfig): PublicResultsStore { return new FilePublicResultsStore(config.store.root); }
