'use strict';
/* eslint-disable no-console, no-sync, unicorn/no-process-exit -- a command-line benchmark script */
// Summarize run-suite.sh output: the median over repetitions per engine, layout and template,
// whether every run returned the same result multiset as the single file, and per-layout totals.
// Prints JSON to stdout, and a Markdown report with --markdown.
//
// Usage: node summarize.js [--markdown] <results.jsonl> [<results.jsonl> ...]
const fs = require('node:fs');

const args = process.argv.slice(2);
const markdown = args[0] === '--markdown';
const files = markdown ? args.slice(1) : args;
const runs = files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));

function median(values) {
  const sorted = [ ...values ].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const unique = values => [ ...new Set(values) ];
const engines = unique(runs.map(run => run.engine));
const layouts = unique(runs.map(run => run.layout));
const templates = unique(runs.map(run => run.template));
const datasets = unique(runs.map(run => run.dataset));

const summary = { datasets, engines, layouts, templates, cells: [], totals: []};
for (const dataset of datasets) {
  const reference = {};
  for (const template of templates) {
    const single = runs.find(run => run.dataset === dataset && run.template === template &&
      run.layout === 'single' && run.r.digest);
    reference[template] = single?.r.digest;
  }
  for (const engine of engines) {
    for (const layout of layouts) {
      let total = 0;
      let complete = true;
      let queries = 0;
      for (const template of templates) {
        const group = runs.filter(run => run.dataset === dataset && run.engine === engine &&
          run.layout === layout && run.template === template);
        if (group.length === 0) {
          continue;
        }
        const ok = group.filter(run => typeof run.r.ms === 'number' && !run.r.error);
        const cell = {
          dataset,
          engine,
          layout,
          template,
          repetitions: group.length,
          failed: group.length - ok.length,
          ms: ok.length > 0 ? median(ok.map(run => run.r.ms)) : null,
          first: ok.length > 0 ? median(ok.map(run => run.r.first ?? run.r.ms)) : null,
          results: ok[0]?.r.results ?? null,
          correct: ok.length > 0 && ok.every(run => run.r.digest === reference[template]),
          queries: ok.length > 0 ? median(ok.map(run => Object.values(run.r.stats).reduce((sum, n) => sum + n, 0))) : null,
          stats: ok[0]?.r.stats ?? group[0].r.stats ?? null,
          error: group.find(run => run.r.error || run.r.timeout)?.r ?? null,
        };
        summary.cells.push(cell);
        if (cell.ms === null) {
          complete = false;
        } else {
          total += cell.ms;
          queries += cell.queries;
        }
      }
      summary.totals.push({ dataset, engine, layout, ms: total, complete, queries });
    }
  }
}

if (!markdown) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const seconds = ms => ms === null ? '—' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
const lines = [];
for (const dataset of datasets) {
  lines.push(`## ${dataset}`, '', `| Layout | ${engines.map(engine => `${engine} total`).join(' | ')} | ${
    engines.map(engine => `${engine} DuckDB queries`).join(' | ')} |`, `| --- |${' ---: |'.repeat(engines.length * 2)}`);
  for (const layout of layouts) {
    const totals = engines.map(engine => summary.totals.find(row => row.dataset === dataset && row.engine === engine &&
      row.layout === layout));
    lines.push(`| ${layout} | ${totals.map(row => `${seconds(row.ms)}${row.complete ? '' : ' (incomplete)'}`).join(' | ')} | ${
      totals.map(row => row.queries.toLocaleString('en')).join(' | ')} |`);
  }
  lines.push('');
  for (const engine of engines) {
    lines.push(`### ${dataset}, ${engine} engine (median ms per template)`, '', `| Template | ${layouts.join(' | ')} |`, `| --- |${' ---: |'.repeat(layouts.length)}`);
    for (const template of templates) {
      const cells = layouts.map(layout => summary.cells.find(cell => cell.dataset === dataset && cell.engine === engine &&
        cell.layout === layout && cell.template === template));
      lines.push(`| ${template} | ${cells.map(cell => cell ?
(cell.ms === null ?
'timeout' :
        `${Math.round(cell.ms)}${cell.correct ? '' : ' ✗'}`) :
'').join(' | ')} |`);
    }
    lines.push('');
  }
}
lines.push('✗ marks a result multiset that differs from the single file.');
console.log(lines.join('\n'));
