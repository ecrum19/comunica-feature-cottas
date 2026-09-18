const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const benchmarks = [ 'watdiv-cottas', 'watdiv-cottas-100', 'bsbm-cottas', 'bsbm-cottas-10k' ];
const script = resolve(__dirname, '../scripts/summarize-results.js');

function artifacts(t, time, error = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cottas-report-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const base of [ false, true ]) {
    for (const benchmark of benchmarks) {
      const output = join(directory, 'artifacts', `performance-benchmark-${base ? 'base-' : ''}${benchmark}`);
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'query-times.csv'), `name;time;results;error;httpRequests\nq1;${base ? 100 : time};1;${error};0\n`);
    }
  }
  return directory;
}

test('processes real CSV reports and writes the Actions comparison summary', (t) => {
  const directory = artifacts(t, 150);
  const result = spawnSync(process.execPath, [ script, 'artifacts', '--compare' ], { cwd: directory });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(readFileSync(join(directory, 'benchmark-summary.md'), 'utf8'), /No benchmark total exceeds/u);
  assert.equal(JSON.parse(readFileSync(join(directory, 'ghbench-total.json'), 'utf8')).length, 4);
});

test('fails a comparison above 150% while preserving the report', (t) => {
  const directory = artifacts(t, 151);
  const result = spawnSync(process.execPath, [ script, 'artifacts', '--compare' ], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(readFileSync(join(directory, 'benchmark-summary.md'), 'utf8'), /Regression detected/u);
});

test('fails reports containing query errors even when their timings are zero', (t) => {
  const directory = artifacts(t, 0, true);
  const result = spawnSync(process.execPath, [ script, 'artifacts' ], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /Benchmark query failed/u);
});
