const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const benchmarks = [ 'watdiv-cottas', 'watdiv-cottas-100', 'bsbm-cottas', 'bsbm-cottas-10k' ];
const labels = [ 'WatDiv-COTTAS', 'WatDiv-COTTAS-100', 'BSBM-COTTAS', 'BSBM-COTTAS-10k' ];

function validateResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('No benchmark measurements were produced.');
  }
  const names = new Set();
  for (const result of results) {
    if (names.has(result.name) || typeof result.name !== 'string' || result.unit !== 'ms' ||
      !Number.isFinite(result.value) || result.value < 0) {
      throw new Error(`Invalid benchmark measurement: ${JSON.stringify(result)}`);
    }
    // PSBR otherwise discards failed queries and can report them as zero milliseconds.
    if (/Error: \[[^\]]*true/u.test(result.extra || '')) {
      throw new Error(`Benchmark query failed: ${result.name} (${result.extra})`);
    }
    names.add(result.name);
  }
}

function compareResults(head, base) {
  validateResults(head);
  validateResults(base);
  const previous = new Map(base.map(result => [ result.name, result ]));
  if (head.length !== base.length || head.some(result => !previous.has(result.name))) {
    throw new Error('Head and base benchmark measurements do not match.');
  }
  return head.map(result => ({
    ...result,
    base: previous.get(result.name).value,
    ratio: previous.get(result.name).value === 0 ?
        (result.value === 0 ? 1 : Number.POSITIVE_INFINITY) :
      result.value / previous.get(result.name).value,
  }));
}

function processResults(artifacts, base, detailed) {
  const name = `ghbench-${base ? 'base-' : ''}${detailed ? 'detail' : 'total'}.json`;
  const directories = benchmarks.map(benchmark =>
    resolve(artifacts, `performance-benchmark-${base ? 'base-' : ''}${benchmark}`));
  const result = spawnSync(resolve(__dirname, '../../node_modules/.bin/psbr'), [
    'csv',
    'ghbench',
    ...directories,
    '--overrideCombinationLabels',
    labels.join(','),
    '--total',
    String(!detailed),
    '--detailed',
    String(detailed),
    '--name',
    name,
  ], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error || new Error('Could not process benchmark measurements.');
  }
  const measurements = JSON.parse(readFileSync(name, 'utf8'));
  validateResults(measurements);
  for (const label of labels) {
    if (!measurements.some(measurement => detailed ?
      measurement.name.startsWith(`${label} - `) :
      measurement.name === label)) {
      throw new Error(`Missing benchmark measurements for ${label}.`);
    }
  }
  return measurements;
}

function table(results, compare) {
  return [
    compare ? '| Benchmark | Base (ms) | Head (ms) | Change |' : '| Benchmark | Time (ms) |',
    compare ? '| --- | ---: | ---: | ---: |' : '| --- | ---: |',
    ...results.map(result => `| ${result.name.replaceAll('|', '\\|')} | ${compare ?
      `${result.base.toFixed(2)} | ${result.value.toFixed(2)} | ${((result.ratio - 1) * 100).toFixed(1)}%` :
      result.value.toFixed(2)} |`),
  ].join('\n');
}

function main() {
  const artifacts = process.argv[2] || 'artifacts';
  const compare = process.argv.includes('--compare');
  let details = processResults(artifacts, false, true);
  let totals = processResults(artifacts, false, false);
  if (compare) {
    details = compareResults(details, processResults(artifacts, true, true));
    totals = compareResults(totals, processResults(artifacts, true, false));
  }
  const regressions = compare ? totals.filter(result => result.ratio > 1.5) : [];
  const comparison = [];
  if (compare) {
    comparison.push(
      'The regression threshold is 150% of the base time for each benchmark total.',
      '',
      regressions.length > 0 ?
        `Regression detected: ${regressions.map(result => result.name).join(', ')}.` :
        'No benchmark total exceeds the regression threshold.',
      '',
    );
  }
  const report = [
    '# COTTAS performance',
    '',
    compare ?
      'Base and head use the same benchmark definitions, RDF data, queries, and COTTAS files.' :
      'Measurements for this commit. A pull request also compares its base commit.',
    '',
    table(totals, compare),
    '',
    ...comparison,
    '<details><summary>Per-query measurements</summary>',
    '',
    table(details, compare),
    '',
    '</details>',
    '',
  ].join('\n');
  writeFileSync('benchmark-summary.md', report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  }
  if (regressions.length > 0) {
    process.exitCode = 1;
  }
}

module.exports = { compareResults, validateResults };
if (require.main === module) {
  main();
}
