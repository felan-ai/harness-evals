import type { PublicBatchManifest, PublicResultsIndex, PublicRunSummary } from './types.js';

export function renderPublicBatchHtml(manifest: PublicBatchManifest): string {
  const matrices = renderBatchMatrices(manifest.runs);
  const embedded = safeJson(manifest);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(manifest.label ?? `Batch ${manifest.batchId}`)}</title>
<style>${styles()}</style>${themeBootstrap()}</head><body><main>
<header class="topbar"><a class="brand" href="../../index.html">${logo()}<span>Felan AI</span></a><div class="topbar-actions"><a class="back" href="../../index.html">Back to archive</a><button id="theme" class="theme" type="button" aria-label="Toggle theme">◐ Theme</button></div></header>
<section class="hero"><p class="eyebrow">Published evaluation batch</p><h1>${escapeHtml(manifest.label ?? `Batch ${manifest.batchId}`)}</h1><p class="meta">${escapeHtml(manifest.batchId)}${manifest.startedAt ? ` · ${escapeHtml(manifest.startedAt)}` : ''}</p></section>
<section class="cards"><div class="card"><b>${manifest.totals.runs}</b><span>Runs</span></div><div class="card"><b>${manifest.totals.passed}</b><span>Passed</span></div><div class="card"><b>${manifest.totals.failed}</b><span>Failed</span></div><div class="card"><b>${manifest.totals.errors}</b><span>Errors</span></div><div class="card"><b>${manifest.totals.skipped}</b><span>Skipped</span></div><div class="card"><b>${manifest.totals.timeouts}</b><span>Timeouts</span></div><div class="card"><b>${manifest.totals.incomplete}</b><span>Incomplete</span></div></section>
<p class="summary-line">${renderTotals(manifest)}</p>
<section class="batch-results"><div class="results-toolbar"><div><p class="eyebrow">Run detail</p><h2>Agent comparison</h2></div><div class="filters"><label>Status <select id="status"><option value="">All statuses</option><option>passed</option><option>failed</option><option>error</option><option>skipped</option><option>timeout</option><option>incomplete</option></select></label><label>Agent <select id="agent"><option value="">All agents</option>${manifest.agents.map((agent) => `<option value="${escapeAttribute(agent)}">${escapeHtml(agent)}</option>`).join('')}</select></label><label>Case <select id="case"><option value="">All cases</option>${manifest.cases.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join('')}</select></label></div></div>
<div id="runs" class="comparison-dashboard batch-groups">${matrices}</div></section>
</main><script type="application/json" id="manifest">${embedded}</script><script>
const status=document.getElementById('status'),agent=document.getElementById('agent'),caseFilter=document.getElementById('case');
function apply(){for(const article of document.querySelectorAll('.batch-case')){const caseMatches=!caseFilter.value||article.dataset.case===caseFilter.value;let visible=0;for(const header of article.querySelectorAll('thead .run-column')){const show=caseMatches&&(!status.value||header.dataset.status===status.value)&&(!agent.value||header.dataset.agent===agent.value);for(const cell of article.querySelectorAll('[data-column="'+header.dataset.column+'"]'))cell.hidden=!show;if(show)visible++;}article.hidden=!caseMatches||visible===0;const table=article.querySelector('table');table.style.setProperty('--matrix-width',Math.max(680,150+visible*280)+'px');table.style.setProperty('--matrix-mobile-width',Math.max(590,118+visible*235)+'px');}for(const suite of document.querySelectorAll('.batch-suite'))suite.hidden=![...suite.querySelectorAll('.batch-case')].some(article=>!article.hidden);}
status.addEventListener('change',apply);agent.addEventListener('change',apply);caseFilter.addEventListener('change',apply);
document.getElementById('theme').addEventListener('click',toggleTheme);
function toggleTheme(){document.documentElement.classList.toggle('dark');try{localStorage.setItem('felan-theme',document.documentElement.classList.contains('dark')?'dark':'light');}catch{}}
</script></body></html>\n`;
}

/** Render a static root page that compares only the selected compact manifests. */
export function renderPublicIndexHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Felan AI · Evaluation results</title><style>${styles()}</style>${themeBootstrap()}</head><body><main>
<header class="topbar"><a class="brand" href="./index.html">${logo()}<span>Felan AI</span></a><button id="theme" class="theme" type="button" aria-label="Toggle theme">◐ Theme</button></header>
<section class="hero"><p class="eyebrow">Public evaluation archive</p><h1>Agent results, compared by task</h1><p class="lede">A compact view of how each agent configuration performs across the published test suites.</p></section>
<section class="toolbar"><label>View <select id="strategy"><option value="latest">Latest results</option><option value="attempts">All runs / attempts</option></select></label><label>Suite <select id="suite"><option value="">All suites</option></select></label><label>Case <select id="case"><option value="">All cases</option></select></label><label>Agent <select id="agent"><option value="">All agents</option></select></label><label>Validity <select id="validity"><option value="">All validity</option><option>valid</option><option>invalid</option><option>superseded</option></select></label><label>Status <select id="status"><option value="">Any status</option><option>passed</option><option>failed</option><option>error</option><option>skipped</option><option>timeout</option><option>incomplete</option></select></label></section>
<p id="message" class="muted" aria-live="polite">Loading archive…</p><section id="summary" class="cards"></section><div id="groups" class="comparison-dashboard"></div>
</main><script>
(() => {
  const fields={strategy:document.getElementById('strategy'),suite:document.getElementById('suite'),case:document.getElementById('case'),agent:document.getElementById('agent'),validity:document.getElementById('validity'),status:document.getElementById('status')};
  const summary=document.getElementById('summary'),groups=document.getElementById('groups'),message=document.getElementById('message'),theme=document.getElementById('theme'); let index;let manifests=[];
  const text=(parent,value,tag='span',className='')=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;parent.append(node);return node;};
  const unique=name=>[...new Set(index.batches.flatMap(batch=>batch[name]||[]))].sort();
  const fill=(field,values)=>values.forEach(value=>{const option=text(field,value,'option');option.value=value;});
  const safeHref=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._\\/-]*$/.test(value)&&!value.startsWith('/')&&!value.includes('\\\\')&&!value.split('/').some(part=>part==='.'||part==='..')?value:'#';
  const time=(run,batch)=>run.startedAt||batch.startedAt||run.runId;
  const comparison=run=>run.comparisonId??run.agentName;
  const statusTotals={passed:'passed',failed:'failed',error:'errors',skipped:'skipped',timeout:'timeouts',incomplete:'incomplete'};
  function selectedBatches(){return index.batches.filter(batch=>(!fields.suite.value||batch.suites.includes(fields.suite.value))&&(!fields.case.value||batch.cases.includes(fields.case.value))&&(!fields.agent.value||batch.agents.includes(fields.agent.value))&&(!fields.validity.value||batch.validity===fields.validity.value)&&(!fields.status.value||batch.totals[statusTotals[fields.status.value]]>0));}
  function selectedRuns(){const rows=[];for(const item of manifests)for(const run of item.manifest.runs)if((!fields.suite.value||run.suite===fields.suite.value)&&(!fields.case.value||run.caseId===fields.case.value)&&(!fields.agent.value||run.agentName===fields.agent.value))rows.push({...run,batch:item.batch});if(fields.strategy.value==='attempts')return rows.sort((a,b)=>time(b,b.batch).localeCompare(time(a,a.batch))||b.runId.localeCompare(a.runId));const latest=new Map();for(const run of rows){const key=run.caseId+'|'+comparison(run);const old=latest.get(key);if(!old||time(run,run.batch)>time(old,old.batch))latest.set(key,run);}return [...latest.values()].sort((a,b)=>a.suite?.localeCompare(b.suite||'')||a.caseId.localeCompare(b.caseId)||comparison(a).localeCompare(comparison(b)));}
  const decimal=value=>Number(value).toFixed(3);
  const integer=value=>Number(value).toLocaleString('en-US');
  const duration=value=>value<1000?value+' ms':value<60000?(value/1000).toFixed(value<10000?2:1)+' s':Math.floor(value/60000)+'m '+Math.round(value%60000/1000)+'s';
  const assertionRate=run=>run.assertionPassRate??(run.assertions?.total?run.assertions.passed/run.assertions.total:undefined);
  function statusBadge(parent,run){const badge=text(parent,run.status,'span','status status-'+run.status);badge.title=run.pass?'Observed passing result':'Observed non-passing result';}
  function metricRow(tbody,label,runs,value,format=String){const values=runs.map(value);if(values.every(item=>item===undefined))return;const row=document.createElement('tr');text(row,label,'th');row.lastChild.scope='row';values.forEach(item=>{const cell=document.createElement('td');text(cell,item===undefined?'—':format(item),'span',item===undefined?'empty-value':'metric-value');row.append(cell);});tbody.append(row);}
  function statusRow(tbody,runs){const row=document.createElement('tr');text(row,'Status','th');row.lastChild.scope='row';runs.forEach(run=>{const cell=document.createElement('td');statusBadge(cell,run);row.append(cell);});tbody.append(row);}
  function assertionRow(tbody,runs){const values=runs.map(assertionRate);if(values.every(value=>value===undefined))return;const row=document.createElement('tr');text(row,'Assertions','th');row.lastChild.scope='row';runs.forEach((run,index)=>{const cell=document.createElement('td');if(values[index]===undefined){text(cell,'—','span','empty-value');}else{const stack=document.createElement('span');stack.className='value-stack';text(stack,Math.round(values[index]*100)+'%','b','metric-value');if(run.assertions)text(stack,run.assertions.passed+' of '+run.assertions.total+' passed','small');cell.append(stack);}row.append(cell);});tbody.append(row);}
  function costRow(tbody,runs){if(runs.every(run=>run.cost?.totalCost===undefined))return;const row=document.createElement('tr');text(row,'Cost','th');row.lastChild.scope='row';runs.forEach(run=>{const cell=document.createElement('td');const value=run.cost?.totalCost;text(cell,value===undefined?'—':value+(run.cost.currency?' '+run.cost.currency:''),'span',value===undefined?'empty-value':'metric-value');row.append(cell);});tbody.append(row);}
  function batchRow(tbody,runs){const row=document.createElement('tr');text(row,'Batch','th');row.lastChild.scope='row';runs.forEach(run=>{const cell=document.createElement('td');const link=document.createElement('a');link.href=safeHref(run.batch.reportPath);link.textContent=run.batch.label||run.batch.batchId;cell.append(link);row.append(cell);});tbody.append(row);}
  function caseMatrix(caseId,runs){const article=document.createElement('article');article.className='case-card case-group';const title=document.createElement('div');title.className='case-title';text(title,caseId,'h3');text(title,runs.length+' '+(fields.strategy.value==='attempts'?'run'+(runs.length===1?'':'s'):'agent'+(runs.length===1?'':'s')),'span','muted');article.append(title);const wrap=document.createElement('div');wrap.className='matrix-wrap';wrap.tabIndex=0;wrap.setAttribute('aria-label','Scrollable agent comparison for '+caseId);const table=document.createElement('table');table.className='metric-matrix';table.style.setProperty('--matrix-width',Math.max(680,150+runs.length*280)+'px');table.style.setProperty('--matrix-mobile-width',Math.max(590,118+runs.length*235)+'px');text(table,'Agent configuration comparison for '+caseId,'caption','sr-only');const columns=document.createElement('colgroup');const metricColumn=document.createElement('col');metricColumn.className='metric-column';columns.append(metricColumn);runs.forEach(()=>{const column=document.createElement('col');column.className='agent-column';columns.append(column);});table.append(columns);const head=document.createElement('thead'),headRow=document.createElement('tr');const metricHeading=text(headRow,'Metric','th');metricHeading.scope='col';runs.forEach(run=>{const cell=document.createElement('th');cell.scope='col';cell.className='participant';const name=run.agentLabel||comparison(run);text(cell,name,'strong');const details=[];if(name!==comparison(run))details.push(comparison(run));if(run.model)details.push(run.model);if(fields.strategy.value==='attempts'){if(run.attemptNumber!==undefined)details.push('attempt '+run.attemptNumber);details.push(run.batch.label||run.batch.batchId);}if(details.length)text(cell,details.join(' · '),'small');headRow.append(cell);});head.append(headRow);table.append(head);const body=document.createElement('tbody');statusRow(body,runs);metricRow(body,'Score',runs,run=>run.score,decimal);assertionRow(body,runs);metricRow(body,'Judge score',runs,run=>run.judgeScore,decimal);metricRow(body,'Verifier reward',runs,run=>run.verifierReward,decimal);metricRow(body,'Duration',runs,run=>run.durationMs,duration);metricRow(body,'Requests',runs,run=>run.cost?.requests,integer);metricRow(body,'Tokens',runs,run=>run.cost?.totalTokens,integer);costRow(body,runs);batchRow(body,runs);table.append(body);wrap.append(table);article.append(wrap);return article;}
  function draw(){const rows=selectedRuns(),counts={runs:rows.length,passed:0,failed:0,errors:0,skipped:0,timeouts:0,incomplete:0};rows.forEach(run=>{if(run.status==='passed')counts.passed++;else if(run.status==='failed')counts.failed++;else if(run.status==='error')counts.errors++;else if(run.status==='skipped')counts.skipped++;else if(run.status==='timeout')counts.timeouts++;else counts.incomplete++;});summary.replaceChildren();[['Runs',counts.runs],['Passed',counts.passed],['Failed',counts.failed],['Errors',counts.errors],['Skipped',counts.skipped],['Timeouts',counts.timeouts],['Incomplete',counts.incomplete]].forEach(([label,value])=>{const card=document.createElement('div');card.className='card';text(card,String(value),'b');text(card,label);summary.append(card);});message.textContent=rows.length+' '+(fields.strategy.value==='latest'?'latest result':'run/attempt')+(rows.length===1?'':'s');groups.replaceChildren();const bySuite=new Map();rows.forEach(run=>{const suite=run.suite||'Uncategorised';if(!bySuite.has(suite))bySuite.set(suite,[]);bySuite.get(suite).push(run);});for(const [suite,suiteRuns] of bySuite){const section=document.createElement('section');section.className='suite suite-group';const heading=document.createElement('div');heading.className='section-heading';text(heading,suite,'h2');text(heading,suiteRuns.length+' comparison result'+(suiteRuns.length===1?'':'s'),'span','muted');section.append(heading);const cases=new Map();suiteRuns.forEach(run=>{if(!cases.has(run.caseId))cases.set(run.caseId,[]);cases.get(run.caseId).push(run);});for(const [caseId,caseRuns] of cases)section.append(caseMatrix(caseId,caseRuns));const links=document.createElement('p');links.className='suite-links';const suiteBatchIds=new Set(suiteRuns.map(run=>run.batch.batchId));for(const batch of selectedBatches().filter(batch=>suiteBatchIds.has(batch.batchId))){const link=document.createElement('a');link.href=safeHref(batch.reportPath);link.textContent=batch.label||batch.batchId;links.append(link);}section.append(links);groups.append(section);}}
  async function load(){try{const response=await fetch('./index.json');if(!response.ok)throw new Error('HTTP '+response.status);index=await response.json();fill(fields.suite,unique('suites'));fill(fields.case,unique('cases'));fill(fields.agent,unique('agents'));await refresh();}catch(error){showError(error);}}
  async function refresh(){message.textContent='Loading archive…';const batches=selectedBatches();manifests=await Promise.all(batches.map(async batch=>{const response=await fetch(safeHref(batch.manifestPath));if(!response.ok)throw new Error('Unable to load '+batch.batchId);return {batch,manifest:await response.json()};}));draw();}
  function showError(error){message.textContent='Unable to load archive: '+error.message;}
  for(const field of Object.values(fields))field.addEventListener('change',()=>refresh().catch(showError));theme.addEventListener('click',()=>{document.documentElement.classList.toggle('dark');try{localStorage.setItem('felan-theme',document.documentElement.classList.contains('dark')?'dark':'light');}catch{}});load();
})();
</script></body></html>\n`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function comparisonId(run: PublicRunSummary): string {
  return run.comparisonId ?? run.agentName;
}

function renderBatchMatrices(runs: readonly PublicRunSummary[]): string {
  const suites = new Map<string, PublicRunSummary[]>();
  for (const run of runs) {
    const suite = run.suite ?? 'Uncategorised';
    const suiteRuns = suites.get(suite) ?? [];
    suiteRuns.push(run);
    suites.set(suite, suiteRuns);
  }
  return [...suites].map(([suite, suiteRuns]) => {
    const cases = new Map<string, PublicRunSummary[]>();
    for (const run of suiteRuns) {
      const caseRuns = cases.get(run.caseId) ?? [];
      caseRuns.push(run);
      cases.set(run.caseId, caseRuns);
    }
    return `<section class="batch-suite suite suite-group"><div class="section-heading"><h2>${escapeHtml(suite)}</h2><span class="muted">${suiteRuns.length} result${suiteRuns.length === 1 ? '' : 's'}</span></div>${[...cases].map(([caseId, caseRuns]) => renderBatchCaseMatrix(caseId, caseRuns)).join('')}</section>`;
  }).join('');
}

function renderBatchCaseMatrix(caseId: string, runs: readonly PublicRunSummary[]): string {
  const matrixWidth = Math.max(680, 150 + (runs.length * 280));
  const mobileWidth = Math.max(590, 118 + (runs.length * 235));
  const headers = runs.map((run, index) => {
    const name = run.agentLabel ?? comparisonId(run);
    const details = [
      name === comparisonId(run) ? undefined : comparisonId(run),
      run.provider,
      run.model,
      run.attemptNumber === undefined ? undefined : `attempt ${run.attemptNumber}`,
    ].filter((value): value is string => value !== undefined);
    return `<th scope="col" class="agent-column participant run-column" data-column="${index}" data-agent="${escapeAttribute(run.agentName)}" data-status="${escapeAttribute(run.status)}"><strong>${escapeHtml(name)}</strong>${details.length ? `<small>${escapeHtml(details.join(' · '))}</small>` : ''}</th>`;
  }).join('');
  const rows = [
    renderBatchStatusRow(runs),
    renderBatchMetricRow('Score', runs, (run) => run.score === undefined ? undefined : run.score.toFixed(3)),
    renderBatchAssertionRow(runs),
    renderBatchMetricRow('Judge score', runs, (run) => run.judgeScore === undefined ? undefined : run.judgeScore.toFixed(3)),
    renderBatchMetricRow('Verifier reward', runs, (run) => run.verifierReward === undefined ? undefined : run.verifierReward.toFixed(3)),
    renderBatchMetricRow('Duration', runs, (run) => run.durationMs === undefined ? undefined : formatDuration(run.durationMs)),
    renderBatchMetricRow('Requests', runs, (run) => run.cost?.requests === undefined ? undefined : run.cost.requests.toLocaleString('en-US')),
    renderBatchMetricRow('Tokens', runs, (run) => run.cost?.totalTokens === undefined ? undefined : run.cost.totalTokens.toLocaleString('en-US')),
    renderBatchMetricRow('Cost', runs, (run) => run.cost?.totalCost === undefined ? undefined : `${run.cost.totalCost}${run.cost.currency ? ` ${run.cost.currency}` : ''}`),
  ].join('');
  return `<article class="batch-case case-card case-group" data-case="${escapeAttribute(caseId)}"><div class="case-title"><h3>${escapeHtml(caseId)}</h3><span class="muted">${runs.length} result${runs.length === 1 ? '' : 's'}</span></div><div class="matrix-wrap" tabindex="0" aria-label="Scrollable agent comparison for ${escapeAttribute(caseId)}"><table class="metric-matrix" style="--matrix-width:${matrixWidth}px;--matrix-mobile-width:${mobileWidth}px"><caption class="sr-only">Agent configuration comparison for ${escapeHtml(caseId)}</caption><thead><tr><th scope="col" class="metric-column">Metric</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function renderBatchStatusRow(runs: readonly PublicRunSummary[]): string {
  return `<tr><th scope="row">Status</th>${runs.map((run, index) => `<td class="run-column" data-column="${index}"><span class="status status-${escapeAttribute(run.status)}">${escapeHtml(run.status)}</span></td>`).join('')}</tr>`;
}

function renderBatchMetricRow(label: string, runs: readonly PublicRunSummary[], valueFor: (run: PublicRunSummary) => string | undefined): string {
  const values = runs.map(valueFor);
  if (values.every((value) => value === undefined)) return '';
  return `<tr><th scope="row">${escapeHtml(label)}</th>${values.map((value, index) => `<td class="run-column" data-column="${index}"><span class="${value === undefined ? 'empty-value' : 'metric-value'}">${escapeHtml(value ?? '—')}</span></td>`).join('')}</tr>`;
}

function renderBatchAssertionRow(runs: readonly PublicRunSummary[]): string {
  const rates = runs.map((run) => run.assertionPassRate ?? (run.assertions?.total ? run.assertions.passed / run.assertions.total : undefined));
  if (rates.every((rate) => rate === undefined)) return '';
  return `<tr><th scope="row">Assertions</th>${rates.map((rate, index) => {
    const run = runs[index];
    if (rate === undefined || !run) return `<td class="run-column" data-column="${index}"><span class="empty-value">—</span></td>`;
    return `<td class="run-column" data-column="${index}"><span class="value-stack"><b class="metric-value">${Math.round(rate * 100)}%</b>${run.assertions ? `<small>${run.assertions.passed} of ${run.assertions.total} passed</small>` : ''}</span></td>`;
  }).join('')}</tr>`;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function renderTotals(manifest: PublicBatchManifest): string {
  const totals = manifest.totals;
  const values = [`${totals.durationMs ?? '—'}${totals.durationMs === undefined ? '' : ' ms'}`];
  if (totals.cost?.totalCost !== undefined) values.push(`${totals.cost.totalCost}${totals.cost.currency ? ` ${totals.cost.currency}` : ''}`);
  if (totals.cost?.totalTokens !== undefined) values.push(`${totals.cost.totalTokens} tokens`);
  return values.join(' · ');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function safeJson(value: PublicBatchManifest | PublicResultsIndex): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({ '<': '\\u003C', '>': '\\u003E', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character] ?? character);
}

function styles(): string {
  return `:root {
  color-scheme: light;
  --background: 0 0% 99%;
  --foreground: 20 14% 11%;
  --card: 0 0% 100%;
  --muted: 30 10% 95%;
  --muted-foreground: 20 6% 44%;
  --border: 30 10% 90%;
  --brand: 152 44% 26%;
  --brand-foreground: 0 0% 100%;
  --brand-surface: 148 29% 94%;
  --destructive: 0 72% 46%;
  --destructive-surface: 0 72% 96%;
  --warning: 27 88% 42%;
  --warning-surface: 30 88% 95%;
  --radius: 0.5rem;
  --sans: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
:root.dark {
  color-scheme: dark;
  --background: 20 10% 7%;
  --foreground: 30 10% 90%;
  --card: 20 8% 10%;
  --muted: 20 8% 15%;
  --muted-foreground: 20 5% 62%;
  --border: 20 6% 18%;
  --brand: 152 46% 42%;
  --brand-foreground: 0 0% 100%;
  --brand-surface: 152 25% 14%;
  --destructive: 0 72% 66%;
  --destructive-surface: 0 30% 17%;
  --warning: 28 88% 64%;
  --warning-surface: 28 30% 16%;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: hsl(var(--background)); }
body { min-height: 100%; margin: 0; padding: 0 28px 56px; background: hsl(var(--background)); color: hsl(var(--foreground)); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
main { width: min(1240px, 100%); margin: 0 auto; }
a { color: hsl(var(--brand)); text-underline-offset: 3px; }
button, select { color: inherit; font: inherit; }
button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid hsl(var(--brand)); outline-offset: 2px; }
.topbar { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid hsl(var(--border)); }
.brand { display: inline-flex; align-items: center; gap: 10px; color: hsl(var(--foreground)); font-size: 16px; font-weight: 700; text-decoration: none; }
.brand img { width: 26px; height: 28px; flex: 0 0 auto; object-fit: contain; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.theme, .back { min-height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px); background: hsl(var(--background)); color: hsl(var(--foreground)); padding: 7px 11px; font-size: 12px; font-weight: 600; text-decoration: none; cursor: pointer; }
.theme:hover, .back:hover { background: hsl(var(--muted)); }
.hero { padding: 52px 0 30px; }
.eyebrow { margin: 0 0 10px; color: hsl(var(--brand)); font: 700 11px/1.3 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
h1 { max-width: 760px; margin: 0; font-size: clamp(30px, 4vw, 44px); line-height: 1.08; letter-spacing: -.035em; }
.lede, .meta { max-width: 680px; margin: 14px 0 0; color: hsl(var(--muted-foreground)); font-size: 15px; }
.meta { font-family: var(--mono); font-size: 12px; }
.toolbar { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 16px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
.toolbar label, .filters label { display: grid; gap: 6px; color: hsl(var(--muted-foreground)); font-size: 11px; font-weight: 600; }
select { width: 100%; min-height: 38px; border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px); background: hsl(var(--background)); padding: 7px 30px 7px 10px; }
.muted { color: hsl(var(--muted-foreground)); }
#message { margin: 14px 2px 0; font-size: 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 18px 0 36px; }
.card { display: flex; flex-direction: column; gap: 2px; min-height: 88px; justify-content: center; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); padding: 16px 18px; box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
.card b { font-size: 24px; line-height: 1.1; letter-spacing: -.025em; }
.card span { color: hsl(var(--muted-foreground)); font-size: 12px; }
.comparison-dashboard { display: grid; gap: 40px; }
.suite, .suite-group { margin: 0; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.section-heading h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
.section-heading > span { font-size: 12px; }
.case-card, .case-group { overflow: hidden; margin-top: 12px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
.case-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid hsl(var(--border)); background: hsl(var(--muted) / .42); }
.case-title h3 { margin: 0; font: 600 13px/1.3 var(--mono); }
.case-title span { font-size: 11px; }
.matrix-wrap { max-width: 100%; overflow: auto; overscroll-behavior-x: contain; }
.metric-matrix { width: 100%; min-width: var(--matrix-width); border-collapse: separate; border-spacing: 0; table-layout: fixed; }
.metric-column { width: 150px; }
.agent-column { width: 280px; }
.metric-matrix th, .metric-matrix td { padding: 12px 16px; border-bottom: 1px solid hsl(var(--border)); text-align: left; vertical-align: middle; }
.metric-matrix tr:last-child th, .metric-matrix tr:last-child td { border-bottom: 0; }
.metric-matrix thead th { position: sticky; top: 0; z-index: 2; border-right: 1px solid hsl(var(--border)); background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); font: 700 10px/1.35 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.metric-matrix thead th:first-child { left: 0; z-index: 4; }
.metric-matrix thead th:last-child { border-right: 0; }
.metric-matrix thead strong { display: block; color: hsl(var(--foreground)); font: 650 13px/1.4 var(--sans); letter-spacing: 0; text-transform: none; }
.metric-matrix thead small { display: block; overflow: hidden; margin-top: 2px; color: hsl(var(--muted-foreground)); font: 400 10px/1.4 var(--mono); letter-spacing: 0; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }
.metric-matrix tbody th { position: sticky; left: 0; z-index: 1; border-right: 1px solid hsl(var(--border)); background: hsl(var(--card)); color: hsl(var(--muted-foreground)); font: 700 10px/1.35 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.metric-matrix tbody td:not(:last-child) { border-right: 1px solid hsl(var(--border)); }
.metric-matrix tbody tr:nth-child(even) td { background: hsl(var(--muted) / .38); }
.metric-matrix a { font-size: 11px; }
.metric-matrix .status { margin-top: 0; }
.status { display: inline-flex; align-items: center; width: fit-content; margin-top: 8px; border-radius: 999px; padding: 4px 8px; font: 700 10px/1.2 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.status-passed { background: hsl(var(--brand-surface)); color: hsl(var(--brand)); }
.status-failed { background: hsl(var(--destructive-surface)); color: hsl(var(--destructive)); }
.status-error { background: hsl(var(--warning-surface)); color: hsl(var(--warning)); }
.status-skipped, .status-timeout, .status-incomplete { background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); }
.metric-value { white-space: nowrap; font: 600 12px/1.35 var(--mono); font-variant-numeric: tabular-nums; }
.value-stack { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
.value-stack small { color: hsl(var(--muted-foreground)); font: 400 10px/1.35 var(--mono); }
.empty-value { color: hsl(var(--muted-foreground)); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.suite-links { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 10px 2px 0; font-size: 11px; }
.summary-line { margin: -24px 0 36px; color: hsl(var(--muted-foreground)); font: 12px/1.5 var(--mono); }
.batch-results { margin: 0; }
.results-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 28px; padding: 18px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
.results-toolbar .eyebrow { margin-bottom: 5px; }
.results-toolbar h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
.filters { display: flex; align-items: end; gap: 10px; }
.filters label { min-width: 130px; }
.batch-groups { gap: 40px; }
.batch-suite[hidden], .batch-case[hidden], .run-column[hidden] { display: none; }
@media (max-width: 920px) {
  .toolbar { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .results-toolbar { align-items: stretch; flex-direction: column; }
  .filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 620px) {
  body { padding: 0 16px 40px; }
  .topbar { min-height: 58px; }
  .brand span { display: none; }
  .hero { padding: 36px 0 24px; }
  .toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px; }
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 30px; }
  .card { min-height: 76px; }
  .section-heading { align-items: start; flex-direction: column; gap: 3px; }
  .metric-column { width: 118px; }
  .agent-column { width: 235px; }
  .metric-matrix { min-width: var(--matrix-mobile-width); }
  .metric-matrix th, .metric-matrix td { padding: 11px 12px; }
  .filters { grid-template-columns: 1fr; }
  .back { display: none; }
}
@media (max-width: 390px) { .toolbar { grid-template-columns: 1fr; } }
@media print { .theme, .toolbar, .results-toolbar { display: none; } body { padding: 0; } }`;
}

function themeBootstrap(): string {
  return `<script>try{const value=localStorage.getItem('felan-theme');if(value==='dark'||(!value&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark');}catch{}</script>`;
}

function logo(): string {
  return `<img src="${FELAN_LOGO_DATA_URI}" alt="" aria-hidden="true">`;
}

// Exact bytes from felan-platform/apps/web/public/felan-logo.svg.
const FELAN_LOGO_DATA_URI = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIj8+CjxzdmcgdmVyc2lvbj0iMS4wIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTAuMDAwMDAwcHQiIGhlaWdodD0iMjU4LjAwMDAwMHB0IiB2aWV3Qm94PSIwIDAgMjUwLjAwMDAwMCAyNTguMDAwMDAwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWlkWU1pZCBtZWV0Ij4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC4wMDAwMDAsMjU4LjAwMDAwMCkgc2NhbGUoMC4xMDAwMDAsLTAuMTAwMDAwKSIgZmlsbD0iIzI1NUY0NCIgc3Ryb2tlPSJub25lIj4KPHBhdGggZD0iTTExMTYgMjM5OSBjLTc3IC0xMSAtMTkxIC00MyAtMjY4IC03NCAtNjAgLTI0IC0yMTQgLTExMCAtMjIyIC0xMjQmI3hBOy0zIC00IDEzIC0yOSAzNSAtNTYgNTYgLTcwIDg0IC0xNjYgNzUgLTI1NiBsLTYgLTY5IDYyIDUxIGMxMzEgMTA2IDI4MiAxNjAmI3hBOzQ1MyAxNjIgMTE5IDEgMTk2IC0xNyAzMTAgLTcyIDM3OCAtMTgzIDUxNiAtNjQ1IDMwMyAtMTAxMyAtNzUgLTEzMCAtMjA5JiN4QTstMjQ3IC0zNDcgLTMwMyAtNDExIC0xNjcgLTg4MyA5MiAtOTY3IDUzMSAtMjYgMTM3IC0xMiAyOTggMzYgNDEwIDExIDI1IDIwJiN4QTs0NyAyMCA0OSAwIDEgLTI4IC05IC02MiAtMjMgLTc4IC0zMyAtMTk3IC0zNiAtMjY4IC04IC0yNSA5IC01MSAxOCAtNTkgMTkmI3hBOy0zNiA1IC02OCAtMjUyIC01MiAtNDEwIDg0IC04MjAgMTAxNiAtMTI3MSAxNjk1IC04MTkgMzI5IDIxOSA1MTggNjIzIDQ3NiYjeEE7MTAxNyAtNDggNDUwIC0zMjMgODA5IC03MjMgOTQ0IC0xNDUgNDggLTM0MCA2NiAtNDkxIDQ0eiI+PC9wYXRoPgo8cGF0aCBkPSJNMjg1IDIxNTYgYy04OSAtNDEgLTEzNSAtMTE1IC0xMzUgLTIxMyAxIC0xODEgMTk3IC0yOTAgMzUwIC0xOTUmI3hBOzExOSA3NCAxNDQgMjQ0IDUyIDM1NCAtMzUgNDEgLTExNiA3OCAtMTcyIDc4IC0yNiAwIC02NiAtMTAgLTk1IC0yNHoiPjwvcGF0aD4KPHBhdGggZD0iTTExNjAgMTYwMSBjLTgzIC0yNSAtMTU2IC05OCAtMTkwIC0xODcgLTcyIC0xOTIgNzEgLTM5NiAyNzkgLTM5NiYjeEE7MzEyIDAgNDAzIDQzNSAxMTggNTY4IC01NCAyNSAtMTUxIDMyIC0yMDcgMTV6Ij48L3BhdGg+CjwvZz4KPC9zdmc+';
