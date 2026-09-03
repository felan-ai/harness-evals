#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadHarnessConfig } from './config/load.js';
import { buildMatrix } from './runner/matrix.js';
import { runHarness } from './runner/evaluate.js';
import type { CliOverrides } from './config/schema.js';
import { buildRunReport } from './visualization/report.js';
import { renderReport } from './visualization/render.js';
import type { VisualizationFormat } from './visualization/types.js';
import { filterTaskRuns, scanWorkspaceRuns, type CaseInfoMap, type WorkspaceScanResult } from './visualization/scan.js';
import { publishBatch, publishBatchStatus } from './results/public/publish.js';
import type { PublicBatchValidity } from './results/public/types.js';
import { filterBenchmarkRuns, resolveBenchmarkSelection } from './benchmarks/select.js';
import { analyzeBenchmark } from './benchmarks/analyze.js';
import { renderBenchmarkCsv, renderBenchmarkHtml, renderBenchmarkIndexHtml, renderBenchmarkJson } from './benchmarks/render.js';
import { reprocessRetained, type ReprocessSource } from './regrade.js';

interface ParsedArgs extends CliOverrides {
  command: string;
  configPath?: string;
  runId?: string;
  latest?: boolean;
  open?: boolean;
  noOpen?: boolean;
  port?: number;
  format?: VisualizationFormat;
  output?: string;
  batch?: string;
  dryRun?: boolean;
  validity?: PublicBatchValidity;
  validityNote?: string;
  supersededBy?: string;
  allowUnfinalized?: boolean;
  sources?: ReprocessSource[];
  probeRunId?: string;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'reprocess') {
    const config = await loadHarnessConfig({ configPath: parsed.configPath });
    if (!parsed.sources?.length) throw new Error('reprocess requires at least one --source <benchmark>=<batch>');
    await reprocessRetained({ configPath: parsed.configPath ?? 'harness-evals.yaml', sources: parsed.sources, concurrency: parsed.concurrency ?? 1, dryRun: parsed.dryRun === true, probeRunId: parsed.probeRunId });
    if (!parsed.dryRun) console.log(await writeBenchmarkIndex(config, parsed));
    return;
  }

  if (parsed.command === 'list') {
    const config = await loadHarnessConfig({ configPath: parsed.configPath });
    const matrix = buildMatrix(config, parsed);
    console.log('Agents:');
    for (const name of Object.keys(config.agents)) console.log(`  ${name} (${config.agents[name].adapter})`);
    console.log('\nCases:');
    for (const testCase of config.testCases) console.log(`  ${testCase.id}${testCase.suite ? ` [${testCase.suite}]` : ''}`);
    console.log(`\nMatrix entries: ${matrix.length}`);
    if (Object.keys(config.benchmarks).length > 0) {
      console.log('\nBenchmarks:');
      for (const [id, benchmark] of Object.entries(config.benchmarks)) console.log(`  ${id} (${benchmark.label})`);
    }
    const readyImage = parsed.dockerImage ?? config.docker.image;
    const runtimeImage = readyImage
      ? `ready (${readyImage})`
      : parsed.refreshManagedImage
        ? 'managed (will refresh before run)'
        : 'managed (built automatically during run)';
    console.log(`Runtime image: ${runtimeImage}`);
    return;
  }

  if (parsed.command === 'publish' || parsed.command === 'publish-status') {
    if (!parsed.batch) throw new Error(`${parsed.command} requires --batch <batch-id>`);
    const config = await loadHarnessConfig({ configPath: parsed.configPath });
    if (!config.results.publish) throw new Error('Results publishing is not configured (add results.publish to harness-evals.yaml)');
    if (parsed.command === 'publish-status') {
      if (!parsed.validity) throw new Error('publish-status requires --validity');
      await publishBatchStatus({ config: config.results.publish, batchId: parsed.batch, validity: parsed.validity, validityNote: parsed.validityNote, supersededBy: parsed.supersededBy, dryRun: parsed.dryRun });
      console.log(parsed.dryRun ? `Validated publication status for ${parsed.batch} (dry run)` : `Updated publication status for ${parsed.batch}`);
    } else {
      const benchmarkCases = Object.fromEntries(Object.entries(config.benchmarks).map(([id, definition]) => [id, config.testCases.filter((testCase) => definition.select.cases?.includes(testCase.id) || (testCase.suite && definition.select.suites?.includes(testCase.suite))).map((testCase) => testCase.id)]));
      const result = await publishBatch({ projectRoot: config.projectRoot, artifactRoot: config.artifactRoot, config: config.results.publish, batchId: parsed.batch, dryRun: parsed.dryRun, validity: parsed.validity, validityNote: parsed.validityNote, supersededBy: parsed.supersededBy, allowUnfinalized: parsed.allowUnfinalized, benchmarks: config.benchmarks, benchmarkCases });
      console.log(result.dryRun ? `Validated batch ${parsed.batch} (dry run)` : `Published batch ${parsed.batch}${result.reportUrl ? `: ${result.reportUrl}` : ''}`);
    }
    return;
  }

  if (parsed.command === 'docker') {
    throw new Error('Managed Docker images are built automatically during harness-evals run. Set docker.image or pass --image to use a ready image and skip managed builds.');
  }

  if (parsed.command === 'view') {
    const benchmarkId = parsed.benchmarkId ?? (!parsed.runId && !parsed.latest ? 'all' : undefined);
    if (benchmarkId) {
      const config = await loadHarnessConfig({ configPath: parsed.configPath });
      const benchmarkRequest = { ...parsed, benchmarkId };
      if (benchmarkId !== 'all') resolveBenchmarkSelection(config, benchmarkId);
      const indexPath = await writeBenchmarkIndex(config, benchmarkRequest);
      const reportPath = benchmarkId === 'all'
        ? indexPath
        : join(config.outputRoot, 'benchmarks', benchmarkId, 'results.html');
      if (parsed.port !== undefined) {
        const path = benchmarkId === 'all' ? '/benchmarks/index.html' : `/benchmarks/${encodeURIComponent(benchmarkId)}/results.html`;
        await serveReports(config, parsed.port, path, parsed.open ?? !parsed.noOpen);
        return;
      }
      console.log(reportPath);
      if (!parsed.noOpen) openPath(reportPath);
      return;
    }
    await viewReport(parsed);
    return;
  }

  if (parsed.command === 'export') {
    if (parsed.benchmarkId) {
      await exportBenchmarkReport(parsed);
      return;
    }
    await exportReport(parsed);
    return;
  }

  if (parsed.command !== 'run') throw new Error(`Unknown command: ${parsed.command}`);

  const result = await runHarness({
    configPath: parsed.configPath,
    cliArgs: process.argv.slice(2),
    agents: parsed.agents,
    caseId: parsed.caseId,
    suite: parsed.suite,
    concurrency: parsed.concurrency,
    attempts: parsed.attempts,
    benchmarkId: parsed.benchmarkId,
    provider: parsed.provider,
    model: parsed.model,
    timeoutMs: parsed.timeoutMs,
    dockerImage: parsed.dockerImage,
    refreshManagedImage: parsed.refreshManagedImage,
    cleanup: parsed.cleanup,
  });

  printResults(result.results);
  console.log(`\nSummary: ${result.outputPath}`);
  process.exitCode = result.pass ? 0 : 1;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() ?? 'run' : 'run';
  const parsed: ParsedArgs = { command };
  if (command === 'docker' && argv[0] && !argv[0].startsWith('-')) argv.shift();

  while (argv.length > 0) {
    const arg = argv.shift();
    if (!arg) continue;

    switch (arg) {
      case '--config':
        parsed.configPath = readValue(argv, arg);
        break;
      case '--suite':
        parsed.suite = readValue(argv, arg);
        break;
      case '--benchmark':
        parsed.benchmarkId = readValue(argv, arg);
        break;
      case '--case':
        parsed.caseId = readValue(argv, arg);
        break;
      case '--agents':
        parsed.agents = readValue(argv, arg).split(',').map((value) => value.trim()).filter(Boolean);
        break;
      case '--concurrency':
        parsed.concurrency = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--attempts':
        parsed.attempts = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--provider':
        parsed.provider = readValue(argv, arg);
        break;
      case '--model':
        parsed.model = readValue(argv, arg);
        break;
      case '--timeout-ms':
        parsed.timeoutMs = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--image':
        parsed.dockerImage = readValue(argv, arg);
        break;
      case '--refresh-managed-image':
        parsed.refreshManagedImage = true;
        break;
      case '--cleanup':
        parsed.cleanup = true;
        break;
      case '--no-cleanup':
        parsed.cleanup = false;
        break;
      case '--run':
        parsed.runId = readValue(argv, arg);
        break;
      case '--latest':
        parsed.latest = true;
        break;
      case '--open':
        parsed.open = true;
        break;
      case '--no-open':
        parsed.noOpen = true;
        break;
      case '--batch':
        parsed.batch = readValue(argv, arg);
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--validity': {
        const value = readValue(argv, arg);
        if (value !== 'valid' && value !== 'invalid' && value !== 'superseded') throw new Error('--validity must be valid, invalid, or superseded');
        parsed.validity = value;
        break;
      }
      case '--validity-note':
        parsed.validityNote = readValue(argv, arg);
        break;
      case '--superseded-by':
        parsed.supersededBy = readValue(argv, arg);
        break;
      case '--allow-unfinalized':
        parsed.allowUnfinalized = true;
        break;
      case '--source':
        (parsed.sources ??= []).push(parseSource(readValue(argv, arg)));
        break;
      case '--probe-run':
        parsed.probeRunId = readValue(argv, arg);
        break;
      case '--port':
        parsed.port = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--format':
        parsed.format = readFormat(readValue(argv, arg));
        break;
      case '--output':
        parsed.output = readValue(argv, arg);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return parsed;
}

function readValue(argv: string[], flag: string): string {
  const value = argv.shift();
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function readPositiveInt(value: string, flag: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseSource(value: string): ReprocessSource {
  const separator = value.indexOf('=');
  const benchmarkId = value.slice(0, separator);
  const batchId = value.slice(separator + 1);
  if (separator <= 0 || !/^[a-z0-9][a-z0-9-]*$/u.test(benchmarkId)) throw new Error(`Invalid --source benchmark: ${value}`);
  if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/u.test(batchId)) throw new Error(`Invalid --source batch ID: ${value}`);
  return { benchmarkId, batchId };
}

async function viewReport(parsed: ParsedArgs): Promise<void> {
  const config = await loadHarnessConfig({ configPath: parsed.configPath });
  if (!parsed.runId && !parsed.latest) throw new Error('view requires --run, --latest, or a benchmark');
  const reportPath = parsed.runId
    ? join(config.artifactRoot, parsed.runId, 'index.html')
    : join(config.outputRoot, 'latest', 'results.html');
  if (!existsSync(reportPath)) throw new Error(`Report not found: ${reportPath}`);

  if (parsed.port !== undefined) {
    const urlPath = parsed.runId ? `/runs/${encodeURIComponent(parsed.runId)}/index.html` : '/latest/results.html';
    await serveReports(config, parsed.port, urlPath, parsed.open ?? false);
    return;
  }

  console.log(reportPath);
  if (parsed.open) openPath(reportPath);
}

async function scanReportRuns(config: Awaited<ReturnType<typeof loadHarnessConfig>>): Promise<WorkspaceScanResult> {
  const caseInfo: CaseInfoMap = {};
  for (const testCase of config.testCases) {
    caseInfo[testCase.id] = { suite: testCase.suite, description: testCase.description };
  }
  return scanWorkspaceRuns({ artifactRoot: config.artifactRoot, caseInfo });
}

async function exportReport(parsed: ParsedArgs): Promise<void> {
  if (!parsed.format) throw new Error('harness-evals export requires --format html|json|csv');
  if (!parsed.output) throw new Error('harness-evals export requires --output <path>');
  if (!parsed.runId && !parsed.latest) throw new Error('harness-evals export requires --benchmark <id>, --run <id>, or --latest');
  const config = await loadHarnessConfig({ configPath: parsed.configPath });
  if (!config.visualization.enabled) throw new Error('Visualization is disabled');
  if (!config.visualization.formats.includes(parsed.format)) throw new Error(`Visualization format is not enabled: ${parsed.format}`);
  const output = resolve(process.cwd(), parsed.output);

  await mkdir(dirname(output), { recursive: true });

  if (parsed.latest) {
    const latest = join(config.outputRoot, 'latest', `results.${parsed.format}`);
    if (!existsSync(latest)) throw new Error(`Report not found: ${latest}`);
    if (parsed.format === 'html') {
      const html = await readFile(latest, 'utf8');
      await writeFile(output, relocateHtmlArtifactLinks(html, config.artifactRoot, output));
    } else {
      await copyFile(latest, output);
    }
    console.log(output);
    return;
  }

  if (parsed.runId) {
    const resultPath = join(config.artifactRoot, parsed.runId, 'result.json');
    if (!existsSync(resultPath)) throw new Error(`Run result not found: ${resultPath}`);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
    const report = buildRunReport(result, { runId: parsed.runId, include: config.visualization.include });
    await writeFile(output, renderReport(report, parsed.format, { reportPath: output }));
    console.log(output);
    return;
  }

}

async function exportBenchmarkReport(parsed: ParsedArgs): Promise<void> {
  if (!parsed.format) throw new Error('harness-evals export requires --format html|json|csv');
  if (!parsed.output) throw new Error('harness-evals export requires --output <path>');
  const config = await loadHarnessConfig({ configPath: parsed.configPath });
  if (parsed.benchmarkId === 'all') throw new Error('Use view --benchmark all for the combined HTML report');
  const output = resolve(process.cwd(), parsed.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, await writeBenchmarkReport(config, parsed, parsed.format, output));
  console.log(output);
}

async function writeBenchmarkReport(
  config: Awaited<ReturnType<typeof loadHarnessConfig>>,
  parsed: ParsedArgs,
  format: VisualizationFormat,
  outputPath?: string,
): Promise<string> {
  if (!parsed.benchmarkId) throw new Error('Benchmark ID is required');
  const selection = resolveBenchmarkSelection(config, parsed.benchmarkId);
  const scan = await scanReportRuns(config);
  const relevantRuns = filterBenchmarkRuns(filterTaskRuns(scan.taskRuns, {
    agents: selection.agentNames,
    cases: selection.testCases.map((testCase) => testCase.id),
  }), selection.id, selection.definition);
  const batchIds = benchmarkBatchIds(parsed.batch, scan, relevantRuns);
  const runs = batchIds ? relevantRuns.filter((run) => batchIds.includes(run.batchId)) : relevantRuns;
  const report = analyzeBenchmark({ id: selection.id, definition: selection.definition, cases: selection.testCases.map((testCase) => testCase.id), runs });
  const content = format === 'html' ? renderBenchmarkHtml(report) : format === 'csv' ? renderBenchmarkCsv(report) : renderBenchmarkJson(report);
  if (outputPath) return content;
  const reportDir = join(config.outputRoot, 'benchmarks', selection.id);
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `results.${format}`);
  await writeFile(reportPath, content);
  return reportPath;
}

async function writeBenchmarkIndex(
  config: Awaited<ReturnType<typeof loadHarnessConfig>>,
  parsed: ParsedArgs,
): Promise<string> {
  const scan = await scanReportRuns(config);
  const reportRoot = join(config.outputRoot, 'benchmarks');
  const reports = [];
  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });
  for (const id of Object.keys(config.benchmarks)) {
    const selection = resolveBenchmarkSelection(config, id);
    const relevantRuns = filterBenchmarkRuns(filterTaskRuns(scan.taskRuns, { agents: selection.agentNames, cases: selection.testCases.map((testCase) => testCase.id) }), id, selection.definition);
    const batchIds = benchmarkBatchIds(parsed.batch, scan, relevantRuns);
    const runs = batchIds ? relevantRuns.filter((run) => batchIds.includes(run.batchId)) : relevantRuns;
    const report = analyzeBenchmark({ id, definition: selection.definition, cases: selection.testCases.map((testCase) => testCase.id), runs });
    reports.push(report);
    const dir = join(reportRoot, id);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(join(dir, 'results.html'), renderBenchmarkHtml(report)),
      writeFile(join(dir, 'results.json'), renderBenchmarkJson(report)),
      writeFile(join(dir, 'results.csv'), renderBenchmarkCsv(report)),
    ]);
  }
  const path = join(reportRoot, 'index.html');
  await writeFile(path, renderBenchmarkIndexHtml(reports));
  return path;
}

function benchmarkBatchIds(batch: string | undefined, scan: WorkspaceScanResult, runs: readonly { batchId: string }[]): string[] | undefined {
  if (batch === 'all') return undefined;
  if (batch && batch !== 'latest') return batch.split(',').map((value) => value.trim()).filter(Boolean);
  const relevant = new Set(runs.map((run) => run.batchId));
  const latest = scan.batches.find((entry) => relevant.has(entry.batchId));
  return latest ? [latest.batchId] : undefined;
}

function readFormat(value: string): VisualizationFormat {
  if (value === 'html' || value === 'json' || value === 'csv') return value;
  throw new Error('--format must be html, json, or csv');
}

function relocateHtmlArtifactLinks(html: string, artifactRoot: string, output: string): string {
  return html.replace(/href="[^"]*" data-http-href="(\/runs\/[^"]+)"/g, (attributes, httpHref: string) => {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(httpHref.slice('/runs/'.length));
    } catch {
      return attributes;
    }
    const artifactPath = safeJoin(artifactRoot, decodedPath);
    if (!artifactPath) return attributes;
    const relativePath = relative(dirname(output), artifactPath);
    const href = isAbsolute(relativePath)
      ? httpHref
      : relativePath.replaceAll('\\', '/').split('/').filter(Boolean).map((part) => part === '..' ? part : encodeURIComponent(part)).join('/') || '.';
    return attributes.replace(/^href="[^"]*"/, `href="${href}"`);
  });
}

async function serveReports(config: Awaited<ReturnType<typeof loadHarnessConfig>>, port: number, initialPath: string, open: boolean): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/') {
        response.writeHead(302, { Location: initialPath });
        response.end();
        return;
      }

      const path = resolveStaticReportPath(config, url.pathname);
      if (!path) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      const fileStat = await stat(path);
      const filePath = fileStat.isDirectory() ? join(path, 'index.html') : path;
      response.writeHead(200, { 'Content-Type': contentType(filePath) });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });

  await new Promise<void>((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}${initialPath}`;
      console.log(url);
      if (open) openPath(url);
    });
    process.once('SIGINT', () => server.close(() => resolveServer()));
    process.once('SIGTERM', () => server.close(() => resolveServer()));
  });
}

function resolveStaticReportPath(config: Awaited<ReturnType<typeof loadHarnessConfig>>, pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  if (decoded.startsWith('/latest/')) return safeJoin(join(config.outputRoot, 'latest'), decoded.slice('/latest/'.length));
  if (decoded.startsWith('/benchmarks/')) return safeJoin(join(config.outputRoot, 'benchmarks'), decoded.slice('/benchmarks/'.length));
  if (decoded.startsWith('/runs/')) return safeJoin(config.artifactRoot, decoded.slice('/runs/'.length));
  return undefined;
}

function safeJoin(root: string, child: string): string | undefined {
  const path = resolve(root, child || 'index.html');
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined;
  return path;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function openPath(path: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.warn(`Could not open report: ${error.message}`));
  child.unref();
}

function printResults(results: Awaited<ReturnType<typeof runHarness>>['results']): void {
  const rows = results.map((result) => ({
    caseId: result.caseId,
    agent: result.agentName,
    status: result.pass ? 'PASS' : 'FAIL',
    exit: String(result.exitCode),
    assertions: `${result.assertions.filter((assertion) => assertion.pass || !assertion.required).length}/${result.assertions.length}`,
    runDir: result.runDir,
  }));

  const widths = {
    caseId: Math.max('CASE'.length, ...rows.map((row) => row.caseId.length)),
    agent: Math.max('AGENT'.length, ...rows.map((row) => row.agent.length)),
    status: Math.max('STATUS'.length, ...rows.map((row) => row.status.length)),
    exit: Math.max('EXIT'.length, ...rows.map((row) => row.exit.length)),
    assertions: Math.max('ASSERT'.length, ...rows.map((row) => row.assertions.length)),
  };

  console.log(`${pad('CASE', widths.caseId)}  ${pad('AGENT', widths.agent)}  ${pad('STATUS', widths.status)}  ${pad('EXIT', widths.exit)}  ${pad('ASSERT', widths.assertions)}  ARTIFACTS`);
  for (const row of rows) {
    console.log(`${pad(row.caseId, widths.caseId)}  ${pad(row.agent, widths.agent)}  ${pad(row.status, widths.status)}  ${pad(row.exit, widths.exit)}  ${pad(row.assertions, widths.assertions)}  ${row.runDir}`);
  }
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function printHelp(): void {
  console.log(`harness-evals

Commands:
  harness-evals run [--config path] [--suite name] [--case id] [--agents a,b] [--concurrency n] [--attempts n]
  harness-evals list [--config path]
  harness-evals view [--config path] [--batch id|latest|all] [--no-open] [--port n]
  harness-evals view --benchmark <id|all> [--config path] [--batch id|latest|all] [--no-open] [--port n]
  harness-evals view --run id | --latest [--open] [--port n]
  harness-evals export --benchmark id [--config path] --format html|json|csv --output path [--batch id|latest|all]
  harness-evals export --run id | --latest --format html|json|csv --output path
  Add --benchmark <id> to run, list, view, or export a declared benchmark.
  Plain view is equivalent to view --benchmark all.
  harness-evals publish --batch id [--config path] [--dry-run] [--validity valid|invalid|superseded] [--validity-note text] [--superseded-by id] [--allow-unfinalized]
  harness-evals publish-status --batch id --validity valid|invalid|superseded [--config path] [--dry-run] [--validity-note text] [--superseded-by id]
  harness-evals reprocess --source <benchmark>=<batch> [--source ...] [--concurrency n] [--dry-run] [--probe-run id]

View / export:
  view (no --run/--latest) generates the benchmark landing page and opens it;
  --no-open suppresses the browser. export requires --benchmark, --latest, or
  --run; --latest copies the last invocation's pre-rendered summary and --run
  exports a single run directory.

Run flags:
  --provider name     Override provider for selected agents
  --model name        Override model for selected agents
  --attempts n                Override attempt count for selected cases
  --timeout-ms n              Override per-run timeout
  --image ref                 Use a ready Docker image and skip managed builds
  --refresh-managed-image     Rebuild managed Docker image with --no-cache (and --pull unless docker.pullOnRefresh is false)
  --cleanup                   Delete adapter cleanup paths after each run (or set HARNESS_EVALS_CLEANUP=1)
  --no-cleanup                Keep adapter cleanup paths after each run (default)
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
