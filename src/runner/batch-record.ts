import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BatchInfo } from './batch.js';

const REAL_BATCH_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export interface LocalBatchRecord {
  schemaVersion: 1;
  batch: BatchInfo;
  status: 'running' | 'completed';
  expectedRunCount: number;
  runIds: string[];
  completedAt?: string;
}

export async function writeRunningBatchRecord(input: {
  projectRoot: string;
  batch: BatchInfo;
  expectedRunCount: number;
}): Promise<LocalBatchRecord> {
  assertExpectedRunCount(input.expectedRunCount);
  const record: LocalBatchRecord = {
    schemaVersion: 1,
    batch: cloneBatch(input.batch),
    status: 'running',
    expectedRunCount: input.expectedRunCount,
    runIds: [],
  };
  await writeLocalBatchRecord(input.projectRoot, record);
  return record;
}

export async function writeCompletedBatchRecord(input: {
  projectRoot: string;
  batch: BatchInfo;
  expectedRunCount: number;
  runIds: string[];
  completedAt?: string;
}): Promise<LocalBatchRecord> {
  assertExpectedRunCount(input.expectedRunCount);
  if (input.runIds.length !== input.expectedRunCount) {
    throw new Error(`Cannot complete batch ${input.batch.batchId}: expected ${input.expectedRunCount} run IDs, received ${input.runIds.length}`);
  }
  if (new Set(input.runIds).size !== input.runIds.length) {
    throw new Error(`Cannot complete batch ${input.batch.batchId}: run IDs must be unique`);
  }
  if (input.runIds.some((runId) => !runId)) {
    throw new Error(`Cannot complete batch ${input.batch.batchId}: run IDs must not be empty`);
  }

  const record: LocalBatchRecord = {
    schemaVersion: 1,
    batch: cloneBatch(input.batch),
    status: 'completed',
    expectedRunCount: input.expectedRunCount,
    runIds: [...input.runIds],
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
  await writeLocalBatchRecord(input.projectRoot, record);
  return record;
}

export async function readLocalBatchRecord(projectRoot: string, batchId: string): Promise<LocalBatchRecord | undefined> {
  const path = localBatchRecordPath(projectRoot, batchId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid local batch record ${path}: ${errorMessage(error)}`);
  }
  return parseLocalBatchRecord(value, path, batchId);
}

export function localBatchRecordPath(projectRoot: string, batchId: string): string {
  assertRealBatchId(batchId);
  return join(projectRoot, '.harness-evals', 'batches', `${batchId}.json`);
}

async function writeLocalBatchRecord(projectRoot: string, record: LocalBatchRecord): Promise<void> {
  const path = localBatchRecordPath(projectRoot, record.batch.batchId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parseLocalBatchRecord(value: unknown, path: string, expectedBatchId: string): LocalBatchRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) throw invalidRecord(path, 'schemaVersion must be 1');
  if (value.status !== 'running' && value.status !== 'completed') throw invalidRecord(path, 'status must be running or completed');
  if (!Number.isInteger(value.expectedRunCount) || (value.expectedRunCount as number) < 0) {
    throw invalidRecord(path, 'expectedRunCount must be a non-negative integer');
  }
  if (!Array.isArray(value.runIds) || !value.runIds.every((runId) => typeof runId === 'string' && runId.length > 0)) {
    throw invalidRecord(path, 'runIds must be an array of non-empty strings');
  }
  const runIds = [...value.runIds] as string[];
  if (new Set(runIds).size !== runIds.length) throw invalidRecord(path, 'runIds must be unique');
  if (!isRecord(value.batch)) throw invalidRecord(path, 'batch must be an object');
  const batch = parseBatchInfo(value.batch, path);
  if (batch.batchId !== expectedBatchId) throw invalidRecord(path, `batch.batchId must be ${expectedBatchId}`);
  if (value.completedAt !== undefined && typeof value.completedAt !== 'string') {
    throw invalidRecord(path, 'completedAt must be a string');
  }

  return {
    schemaVersion: 1,
    batch,
    status: value.status,
    expectedRunCount: value.expectedRunCount as number,
    runIds,
    completedAt: value.completedAt as string | undefined,
  };
}

function parseBatchInfo(value: Record<string, unknown>, path: string): BatchInfo {
  if (typeof value.batchId !== 'string' || !REAL_BATCH_ID_PATTERN.test(value.batchId)) {
    throw invalidRecord(path, 'batch.batchId is invalid');
  }
  if (typeof value.startedAt !== 'string' || !value.startedAt) throw invalidRecord(path, 'batch.startedAt must be a string');
  const label = optionalString(value.label, path, 'batch.label');
  const argv = optionalStringArray(value.argv, path, 'batch.argv');
  const agents = optionalStringArray(value.agents, path, 'batch.agents');
  const caseCount = optionalNonNegativeInteger(value.caseCount, path, 'batch.caseCount');
  const runCount = optionalNonNegativeInteger(value.runCount, path, 'batch.runCount');
  return { batchId: value.batchId, startedAt: value.startedAt, label, argv, agents, caseCount, runCount };
}

function cloneBatch(batch: BatchInfo): BatchInfo {
  assertRealBatchId(batch.batchId);
  return {
    ...batch,
    argv: batch.argv ? [...batch.argv] : undefined,
    agents: batch.agents ? [...batch.agents] : undefined,
  };
}

function assertRealBatchId(batchId: string): void {
  if (!REAL_BATCH_ID_PATTERN.test(batchId)) throw new Error(`Invalid batch ID: ${batchId}`);
}

function assertExpectedRunCount(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error('expectedRunCount must be a non-negative integer');
}

function optionalString(value: unknown, path: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRecord(path, `${field} must be a string`);
  return value;
}

function optionalStringArray(value: unknown, path: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidRecord(path, `${field} must be an array of strings`);
  }
  return [...value] as string[];
}

function optionalNonNegativeInteger(value: unknown, path: string, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw invalidRecord(path, `${field} must be a non-negative integer`);
  return value as number;
}

function invalidRecord(path: string, reason: string): Error {
  return new Error(`Invalid local batch record ${path}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
