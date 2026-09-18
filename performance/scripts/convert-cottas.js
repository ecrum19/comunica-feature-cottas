const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const directory = resolve(process.argv[2] || 'generated');
if (!existsSync(resolve(directory, 'dataset.nt'))) {
  throw new Error(`Missing ${directory}/dataset.nt; run the benchmark's performance:prepare script.`);
}

const image = 'comunica-cottas-benchmark-writer';
for (const args of [
  [ 'build', '-t', image, resolve(__dirname, 'cottas-converter') ],
  [ 'run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`, '--volume', `${directory}:/data`, image ],
]) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`COTTAS conversion failed (docker exited with ${result.status}).`);
  }
}
