const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { validateResults } = require('./summarize-results');

for (const directory of process.argv.slice(2)) {
  const output = resolve(directory);
  const name = join(directory, 'ghbench-detail.json');
  const result = spawnSync(resolve(__dirname, '../../node_modules/.bin/psbr'), [
    'csv',
    'ghbench',
    output,
    '--total',
    'false',
    '--detailed',
    'true',
    '--name',
    name,
  ], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`Could not process benchmark results in ${output}.`);
  }
  validateResults(JSON.parse(readFileSync(name, 'utf8')));
}
