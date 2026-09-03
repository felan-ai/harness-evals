import { dirname, relative } from 'node:path';
import type {
  AgentReportColumn,
  RunReport,
  TestCaseAgentReportCell,
  TestCaseReportRow,
  VisualizationFormat,
} from './types.js';
import { THEME_TOKENS } from './theme.js';

export interface RenderReportOptions {
  reportPath?: string;
}

export function renderReport(report: RunReport, format: VisualizationFormat, options: RenderReportOptions = {}): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'csv') return renderCsv(report);
  return renderHtml(report, options);
}

export function renderHtml(report: RunReport, options: RenderReportOptions = {}): string {
  const testCases = report.rows.map((row, rowIndex) => renderTestCase(row, report.columns, report.runId, rowIndex, options.reportPath)).join('\n');
  const passAtK = passAtKSummary(report.summary.passAtK);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Evals Results</title>
<style>
${THEME_TOKENS}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:400 14px/1.5 var(--sans)}main{max-width:1480px;margin:0 auto;padding:32px 24px 56px}a{color:var(--muted)}a:hover{color:var(--ink)}h1{font:400 clamp(1.8rem,3vw,2.5rem)/1.1 var(--serif);margin:0 0 4px}.meta{color:var(--soft);font:400 11px var(--mono)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:24px 0}.card{min-width:0;background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:12px 14px}.card span{display:block;color:var(--soft);font:500 9px var(--mono);letter-spacing:.12em;text-transform:uppercase}.card b{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;font:500 20px var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}.controls{margin:0 0 24px;display:flex;gap:8px;flex-wrap:wrap}.controls button{min-height:36px;border:1px solid var(--rule-solid);background:var(--card);color:var(--ink);border-radius:6px;padding:7px 11px;font:500 12px var(--sans);cursor:pointer}.controls button:hover,.controls button[aria-pressed="true"]{border-color:var(--ink);background:var(--paper-2)}button:focus-visible,a:focus-visible,.matrix-wrap:focus-visible{outline:3px solid rgba(235,108,54,.35);outline-offset:2px}.test-cases{display:grid;gap:20px}.test-case{background:var(--card);border:1px solid var(--rule);border-radius:10px;overflow:hidden}.case-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:18px 20px;border-bottom:1px solid var(--rule)}.case-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.case-title h2{margin:0;font:600 17px var(--sans)}.suite{border:1px solid var(--rule);border-radius:999px;padding:2px 7px;color:var(--soft);font:500 9px var(--mono);letter-spacing:.08em;text-transform:uppercase}.case-description{max-width:900px;margin:5px 0 0;color:var(--muted);font-size:13px}.case-summary{margin:3px 0 0;white-space:nowrap;color:var(--soft);font:400 10px var(--mono)}.matrix-wrap{max-width:100%;overflow:auto;overscroll-behavior-x:contain}.metric-matrix{width:100%;min-width:var(--matrix-width);border-collapse:separate;border-spacing:0;table-layout:fixed}.metric-column{width:150px}.agent-column{width:290px}.metric-matrix th,.metric-matrix td{padding:12px 16px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:middle}.metric-matrix tr:last-child th,.metric-matrix tr:last-child td{border-bottom:0}.metric-matrix thead th{position:sticky;top:0;z-index:2;background:var(--paper-2);color:var(--muted);font:500 9px var(--mono);letter-spacing:.12em;text-transform:uppercase}.metric-matrix thead th:first-child{left:0;z-index:4}.metric-matrix thead th:not(:last-child),.metric-matrix tbody td:not(:last-child){border-right:1px solid var(--rule)}.metric-matrix thead strong{display:block;color:var(--ink);font:600 13px var(--sans);letter-spacing:0;text-transform:none}.metric-matrix thead small{display:block;margin-top:2px;color:var(--muted);font:400 10px var(--mono);letter-spacing:0;text-transform:none}.metric-matrix tbody th{position:sticky;left:0;z-index:1;background:var(--paper);color:var(--muted);font:500 9px var(--mono);letter-spacing:.12em;text-transform:uppercase}.metric-matrix tbody tr:nth-child(even) td{background:rgba(236,236,236,.35)}.metric-value{white-space:nowrap;font:500 13px var(--mono);font-variant-numeric:tabular-nums}.status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 8px;font:500 10px var(--mono);text-transform:uppercase;white-space:nowrap}.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.passed{background:var(--pass-tint);color:var(--pass)}.failed,.error{background:var(--accent-tint);color:var(--accent)}.skipped,.incomplete{background:var(--paper-2);color:var(--muted)}.assertion-summary{display:flex;align-items:baseline;gap:8px;white-space:nowrap}.assertion-summary small{color:var(--soft);font:400 9px var(--mono)}.result-message{font-size:12px}.fail{color:var(--accent)}.ok{color:var(--pass)}.muted{color:var(--soft)}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.actions>a,.details-button{min-height:36px;border:1px solid var(--rule-solid);border-radius:6px;padding:7px 10px;font:600 11px var(--sans);text-decoration:none}.actions>a{display:inline-flex;align-items:center;background:var(--card);color:var(--ink)}.details-button{background:var(--ink);border-color:var(--ink);color:var(--card);cursor:pointer}.details-button:hover{background:var(--muted)}.details-content{min-width:0;padding-top:8px}.details-content h4{margin:16px 0 6px}.details-content h4:first-child{margin-top:8px}pre{white-space:pre-wrap;word-break:break-word;background:var(--ink);color:var(--paper);padding:10px;border-radius:6px;max-height:320px;overflow:auto;font:400 11px var(--mono)}ul{padding-left:18px}.empty-value{color:var(--soft)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.details-dialog{width:min(900px,calc(100vw - 32px));height:min(82dvh,820px);max-width:none;max-height:none;padding:0;overflow:hidden;border:1px solid var(--rule-solid);border-radius:10px;background:var(--card);color:var(--ink)}.details-dialog::backdrop{background:rgba(45,49,66,.52)}.dialog-shell{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%}.dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--rule);background:var(--card)}.dialog-header h2{margin:0;font:600 17px var(--sans)}.dialog-header p{margin:3px 0 0;color:var(--soft);font:400 10px var(--mono)}.dialog-close{flex:none;width:44px;height:44px;border:1px solid var(--rule-solid);border-radius:6px;background:var(--card);color:var(--ink);font:500 22px/1 var(--sans);cursor:pointer}.dialog-close:hover{background:var(--paper-2)}.dialog-body{min-height:0;overflow:auto;padding:4px 20px 24px;overscroll-behavior:contain}[hidden]{display:none!important}@media(max-width:760px){main{padding:20px 12px 40px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.case-header{display:block}.case-summary{margin-top:8px}.metric-column{width:118px}.agent-column{width:235px}.metric-matrix{min-width:var(--matrix-mobile-width)}.metric-matrix th,.metric-matrix td{padding:11px 12px}.details-dialog{width:100vw;height:100dvh;margin:0;max-width:none;border:0;border-radius:0}.dialog-body{padding-bottom:calc(24px + env(safe-area-inset-bottom))}}@media(prefers-reduced-motion:reduce){.details-dialog{scroll-behavior:auto}}
</style>
<script>
function filterRows(kind){
  for(const section of document.querySelectorAll('.test-case')){
    section.hidden=kind!=='all'&&!section.dataset.statuses.split(' ').includes(kind);
  }
  for(const button of document.querySelectorAll('[data-filter]'))button.setAttribute('aria-pressed',String(button.dataset.filter===kind));
}
function sortRows(kind){
  const list=document.getElementById('test-cases');
  [...list.children].sort((a,b)=>kind==='case'?a.dataset.case.localeCompare(b.dataset.case):Number(a.dataset[kind]||0)-Number(b.dataset[kind]||0)).forEach(section=>list.appendChild(section));
}
function rewriteHttpLinks(root){
  if(location.protocol==='http:'||location.protocol==='https:')for(const link of root.querySelectorAll('[data-http-href]'))link.setAttribute('href',link.dataset.httpHref);
}
document.addEventListener('DOMContentLoaded',()=>{
  rewriteHttpLinks(document);
  for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>filterRows(button.dataset.filter));
  for(const button of document.querySelectorAll('[data-sort]'))button.addEventListener('click',()=>sortRows(button.dataset.sort));
  const dialog=document.getElementById('details-dialog');
  const body=document.getElementById('dialog-body');
  const title=document.getElementById('dialog-title');
  let opener=null;
  function closeDetails(){if(dialog.open)dialog.close()}
  function openDetails(button){
    const template=document.getElementById(button.dataset.details);
    if(!template)return;
    opener=button;
    title.textContent=button.dataset.title||'Run details';
    body.replaceChildren(template.content.cloneNode(true));
    rewriteHttpLinks(body);
    dialog.showModal();
    document.body.style.overflow='hidden';
    dialog.querySelector('.dialog-close').focus();
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDetails()});
  dialog.addEventListener('close',()=>{document.body.style.overflow='';if(opener)opener.focus();opener=null;body.replaceChildren()});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDetails()});
  dialog.querySelector('.dialog-close').addEventListener('click',closeDetails);
  for(const button of document.querySelectorAll('[data-details]'))button.addEventListener('click',()=>openDetails(button));
});
</script>
</head>
<body>
<main>
<h1>Harness Evals Results: ${escapeHtml(formatStatus(report.status))}</h1>
<div class="meta">Run ${escapeHtml(report.runId)}</div>
<section class="cards" aria-label="Run summary">
${card('Test cases', formatInteger(report.rows.length))}${card('Agent runs', formatInteger(report.summary.total))}${card('Passed runs', formatInteger(report.summary.passed))}${card('Failed runs', formatInteger(report.summary.failed))}${card('Errors', formatInteger(report.summary.errors))}${report.summary.skipped > 0 ? card('Skipped', formatInteger(report.summary.skipped)) : ''}${card('Score', formatNumber(report.summary.score))}${card('Agent time', formatDuration(report.summary.durationMs))}${card('Cost', formatCost(report.summary.cost?.rollup?.totalCost, report.summary.cost?.currency ?? report.summary.cost?.rollup?.currency))}${card('Tokens', formatInteger(report.summary.tokenUsage?.totalTokens))}${passAtK === 'n/a' ? '' : card('pass@k', passAtK)}
</section>
<nav class="controls" aria-label="Report filters and sorting"><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="failed" aria-pressed="false">Failures</button><button type="button" data-filter="passed" aria-pressed="false">Passes</button><button type="button" data-filter="error" aria-pressed="false">Errors</button><button type="button" data-filter="skipped" aria-pressed="false">Skipped</button><button type="button" data-filter="incomplete" aria-pressed="false">Incomplete</button><button type="button" data-sort="case">Sort case</button><button type="button" data-sort="score">Sort score</button><button type="button" data-sort="duration">Sort duration</button><button type="button" data-sort="cost">Sort cost</button></nav>
<div class="test-cases" id="test-cases">${testCases}</div>
</main>
<dialog class="details-dialog" id="details-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-shell"><header class="dialog-header"><div><h2 id="dialog-title">Run details</h2><p>Diagnostics and artifacts</p></div><button type="button" class="dialog-close" aria-label="Close details">×</button></header><div class="dialog-body" id="dialog-body"></div></div></dialog>
</body></html>\n`;
}

export function renderCsv(report: RunReport): string {
  const header = ['runId', 'testCaseId', 'suite', 'agentName', 'adapter', 'provider', 'model', 'status', 'score', 'durationMs', 'totalAssertions', 'failedAssertions', 'requiredFailed', 'cost', 'totalTokens', 'runDir'];
  const rows = report.rows.flatMap((row) => report.columns.map((column) => {
    const cell = row.cells[column.key];
    if (!cell) return undefined;
    return [report.runId, row.testCaseId, row.suite, column.agentName, column.adapter, column.provider, column.model, cell.status, cell.score, cell.durationMs, cell.assertionSummary.total, cell.assertionSummary.failed, cell.assertionSummary.requiredFailed, cell.cost?.rollup?.totalCost, cell.tokenUsage?.totalTokens, cell.runDir].map(csvCell).join(',');
  }).filter((row): row is string => row !== undefined));
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

function renderTestCase(
  row: TestCaseReportRow,
  columns: AgentReportColumn[],
  reportRunId: string,
  rowIndex: number,
  reportPath?: string,
): string {
  const cellsByColumn = columns.map((column) => row.cells[column.key]);
  const cells = cellsByColumn.filter((cell): cell is TestCaseAgentReportCell => cell !== undefined);
  const passed = cells.filter((cell) => cell.status === 'passed').length;
  const statuses = cellsByColumn.map((cell) => cell?.status ?? 'incomplete');
  const status = caseStatus(statuses);
  const columnHeaders = columns.map((column) => `<th scope="col"><strong>${escapeHtml(column.agentName)}</strong><small>${escapeHtml(agentMeta(column))}</small></th>`).join('');
  const metricRows = [
    renderMetricRow('Status', row, columns, (cell) => `<span class="status ${cell.status}">${escapeHtml(formatStatus(cell.status))}</span>`, '<span class="status incomplete">Not run</span>'),
    renderMetricRow('Score', row, columns, (cell) => `<span class="metric-value">${escapeHtml(formatNumber(cell.score))}</span>`),
    renderMetricRow('Duration', row, columns, (cell) => `<span class="metric-value">${escapeHtml(formatDuration(cell.durationMs))}</span>`),
    renderMetricRow('Requests', row, columns, (cell) => `<span class="metric-value">${escapeHtml(formatInteger(cell.tokenUsage?.requests))}</span>`),
    renderMetricRow('Tokens', row, columns, (cell) => `<span class="metric-value">${escapeHtml(formatInteger(cell.tokenUsage?.totalTokens))}</span>`),
    renderMetricRow('Cost', row, columns, (cell) => `<span class="metric-value">${escapeHtml(formatCost(cell.cost?.rollup?.totalCost, cell.cost?.currency ?? cell.cost?.rollup?.currency))}</span>`),
    renderMetricRow('Assertions', row, columns, (cell) => `<span class="assertion-summary"><strong>${escapeHtml(`${cell.assertionSummary.passed} of ${cell.assertionSummary.total}`)}</strong><small>${escapeHtml(`${cell.assertionSummary.requiredFailed} required failed`)}</small></span>`),
    renderMetricRow('Result', row, columns, (cell) => `<span class="result-message ${resultClass(cell.status)}">${escapeHtml(resultSummary(cell))}</span>`),
    renderMetricRow('Actions', row, columns, (cell, column, columnIndex) => renderActions(reportRunId, reportPath, row.testCaseId, rowIndex, column, columnIndex, cell)),
  ].join('');
  const runSummary = cells.length === columns.length
    ? `${formatInteger(columns.length)} agent config${columns.length === 1 ? '' : 's'}`
    : `${formatInteger(cells.length)} of ${formatInteger(columns.length)} agent configs ran`;
  const matrixWidth = Math.max(760, 150 + (columns.length * 290));
  const mobileMatrixWidth = Math.max(590, 118 + (columns.length * 235));
  return `<section class="test-case" data-case="${escapeAttr(row.testCaseId)}" data-statuses="${escapeAttr(statuses.join(' '))}" data-score="${minNumber(cells.map((cell) => cell.score))}" data-duration="${maxNumber(cells.map((cell) => cell.durationMs))}" data-cost="${maxNumber(cells.map((cell) => cell.cost?.rollup?.totalCost))}">
<header class="case-header"><div><div class="case-title"><h2>${escapeHtml(row.testCaseId)}</h2>${row.suite ? `<span class="suite">${escapeHtml(row.suite)}</span>` : ''}<span class="status ${status}">${escapeHtml(caseStatusLabel(statuses))}</span></div>${row.description ? `<p class="case-description">${escapeHtml(row.description)}</p>` : ''}</div><p class="case-summary">${runSummary} · ${formatInteger(passed)} passed</p></header>
<div class="matrix-wrap" tabindex="0" aria-label="Scrollable comparison for ${escapeAttr(row.testCaseId)}"><table class="metric-matrix" style="--matrix-width:${matrixWidth}px;--matrix-mobile-width:${mobileMatrixWidth}px"><caption class="sr-only">Agent configuration comparison for ${escapeHtml(row.testCaseId)}</caption><colgroup><col class="metric-column">${columns.map(() => '<col class="agent-column">').join('')}</colgroup><thead><tr><th scope="col">Metric</th>${columnHeaders}</tr></thead><tbody>${metricRows}</tbody></table></div>
</section>`;
}

function renderMetricRow(
  label: string,
  row: TestCaseReportRow,
  columns: AgentReportColumn[],
  renderCell: (cell: TestCaseAgentReportCell, column: AgentReportColumn, columnIndex: number) => string,
  missing = '<span class="empty-value">—</span>',
): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th>${columns.map((column, columnIndex) => {
    const cell = row.cells[column.key];
    return `<td>${cell ? renderCell(cell, column, columnIndex) : missing}</td>`;
  }).join('')}</tr>`;
}

function renderActions(
  reportRunId: string,
  reportPath: string | undefined,
  testCaseId: string,
  rowIndex: number,
  column: AgentReportColumn,
  columnIndex: number,
  cell: TestCaseAgentReportCell,
): string {
  const detailId = `details-${rowIndex}-${columnIndex}`;
  const detailTitle = `${column.agentName} · ${testCaseId}`;
  const runLink = artifactLinkAttributes(reportRunId, reportPath, cell.runDir);
  return `<div class="actions">${runLink ? `<a ${runLink}>Run artifacts</a>` : ''}<button type="button" class="details-button" data-details="${escapeAttr(detailId)}" data-title="${escapeAttr(detailTitle)}">View details</button></div><template id="${escapeAttr(detailId)}"><div class="details-content">
${renderDetails(reportRunId, reportPath, cell)}</div></template>`;
}

function renderDetails(reportRunId: string, reportPath: string | undefined, cell: TestCaseAgentReportCell): string {
  const failedAssertions = (cell.details.assertions ?? []).filter((assertion) => isRecord(assertion) && assertion.pass !== true);
  return [
    cell.details.error ? `<h4>Error</h4><div class="fail">${escapeHtml(sanitizeDisplayText(cell.details.error))}</div>` : '',
    failedAssertions.length > 0 ? `<h4>Failed assertions</h4><ul>${failedAssertions.map((assertion) => `<li>${renderJson(assertion)}</li>`).join('')}</ul>` : '',
    cell.details.verifier !== undefined ? `<h4>Verifier</h4><pre>${renderJson(cell.details.verifier)}</pre>` : '',
    `<h4>Steps</h4><pre>${renderJson(cell.details.steps)}</pre>`,
    cell.details.toolCalls !== undefined ? `<h4>Tool calls</h4><pre>${renderJson(cell.details.toolCalls)}</pre>` : '',
    cell.details.mockCalls !== undefined ? `<h4>Mock calls</h4><pre>${renderJson(cell.details.mockCalls)}</pre>` : '',
    cell.details.judgeResults !== undefined ? `<h4>Judge results</h4><pre>${renderJson(cell.details.judgeResults)}</pre>` : '',
    cell.details.workspaceDiff !== undefined ? `<h4>Workspace diff</h4><pre>${renderJson(cell.details.workspaceDiff)}</pre>` : '',
    cell.details.logs !== undefined ? `<h4>Logs</h4><ul>${cell.details.logs.map((log) => {
      const link = artifactLinkAttributes(reportRunId, reportPath, cell.runDir, log.href);
      return link ? `<li><a ${link}>${escapeHtml(log.label)}</a></li>` : '';
    }).join('')}</ul>` : '',
  ].join('');
}

function caseStatus(statuses: Array<TestCaseAgentReportCell['status']>): TestCaseAgentReportCell['status'] {
  if (statuses.some((status) => status === 'error')) return 'error';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.length > 0 && statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'incomplete')) return 'incomplete';
  if (statuses.some((status) => status === 'skipped')) return 'skipped';
  return 'incomplete';
}

function caseStatusLabel(statuses: Array<TestCaseAgentReportCell['status']>): string {
  if (statuses.length === 0) return 'Incomplete';
  const counts = new Map<TestCaseAgentReportCell['status'], number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count > 1 ? `${count} ` : ''}${formatStatus(status)}`).join(' · ');
}

function agentMeta(column: AgentReportColumn): string {
  return [column.provider, column.model].filter(Boolean).join(' · ') || column.adapter || 'agent';
}

function resultSummary(cell: TestCaseAgentReportCell): string {
  if (cell.details.error) return sanitizeDisplayText(cell.details.error);
  if (cell.assertionSummary.requiredFailed > 0) {
    return `${cell.assertionSummary.requiredFailed} required assertion${cell.assertionSummary.requiredFailed === 1 ? '' : 's'} failed`;
  }
  return cell.status === 'passed' ? 'Completed' : formatStatus(cell.status);
}

function resultClass(status: TestCaseAgentReportCell['status']): 'ok' | 'fail' | 'muted' {
  if (status === 'passed') return 'ok';
  if (status === 'failed' || status === 'error') return 'fail';
  return 'muted';
}

function artifactLinkAttributes(reportRunId: string, reportPath: string | undefined, runDir: string | undefined, childPath?: string): string | undefined {
  const href = artifactHref(reportRunId, reportPath, runDir, childPath);
  if (!href || !runDir) return undefined;
  const httpHref = serverArtifactHref(runDir, childPath);
  return `href="${escapeAttr(href)}"${httpHref ? ` data-http-href="${escapeAttr(httpHref)}"` : ''}`;
}

function artifactHref(reportRunId: string, reportPath: string | undefined, runDir: string | undefined, childPath?: string): string | undefined {
  if (!runDir) return undefined;
  const base = reportPath ? relativeArtifactHref(reportPath, runDir) : fallbackArtifactHref(reportRunId, runDir);
  if (!base) return undefined;
  if (!childPath) return base;
  const child = safeRelativeHref(childPath);
  return child ? `${base}/${child}` : undefined;
}

function serverArtifactHref(runDir: string, childPath?: string): string | undefined {
  const runName = runNameFromDir(runDir);
  if (!runName) return undefined;
  const child = childPath ? safeRelativeHref(childPath) : undefined;
  if (childPath && !child) return undefined;
  return `/runs/${encodeURIComponent(runName)}${child ? `/${child}` : ''}`;
}

function relativeArtifactHref(reportPath: string, runDir: string): string | undefined {
  const relativeRunDir = relative(dirname(reportPath), runDir).replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(relativeRunDir)) return undefined;
  if (!relativeRunDir) return '.';
  return relativeRunDir.split('/').filter(Boolean).map((part) => part === '..' ? part : encodeURIComponent(part)).join('/');
}

function fallbackArtifactHref(reportRunId: string, runDir: string): string | undefined {
  const runName = runNameFromDir(runDir);
  if (!runName) return undefined;
  return reportRunId === 'latest' ? `../../runs/${encodeURIComponent(runName)}` : '.';
}

function runNameFromDir(runDir: string): string | undefined {
  const runName = runDir.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  return runName && runName !== '.' && runName !== '..' ? runName : undefined;
}

function safeRelativeHref(value: string): string | undefined {
  const parts = value.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined;
  return parts.map(encodeURIComponent).join('/');
}

function renderJson(value: unknown): string {
  return escapeHtml(sanitizeDisplayText(JSON.stringify(value, null, 2) ?? String(value)));
}

function sanitizeDisplayText(value: string): string {
  let sanitized = value;
  const projectRoot = process.cwd();
  const home = process.env.HOME;
  if (projectRoot) sanitized = sanitized.replaceAll(projectRoot, '<project>');
  if (home) sanitized = sanitized.replaceAll(home, '~');
  return sanitized;
}

function passAtKSummary(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'n/a';
  const eligible = value.filter((entry) => isRecord(entry) && entry.eligible === true);
  if (eligible.length === 0) return 'n/a';
  return eligible.map((entry) => {
    const values = isRecord(entry.values) ? entry.values : {};
    const last = Object.entries(values).at(-1);
    return last ? `${last[0]}=${formatNumber(last[1])}` : 'n/a';
  }).join(', ');
}

function card(label: string, value: unknown): string {
  return `<div class="card"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value ?? 'n/a'))}</b></div>`;
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function formatDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatStatus(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function formatCost(value: unknown, currency = 'USD'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const normalized = value.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  return currency === 'USD' ? `$${normalized}` : `${normalized} ${currency}`;
}

function formatInteger(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString('en-US')
    : '—';
}

function minNumber(values: Array<number | undefined>): number {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.min(...present) : 0;
}

function maxNumber(values: Array<number | undefined>): number {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;');
}
