const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const revision = '8b63d56f87576c3878368567d1c9ef79c2b889ee';
const checksums = {
  10: '3a9876a5d62e1f2bc0ab7b6f188e9ee66658a0b1d6600e82b03dd85453f35189',
  100: '1731820db2a200f6d04e8c1c1bb42ac624fabde6a43d485bc1eeda5294651843',
};

async function main() {
  const scale = process.argv[2];
  const expected = checksums[scale];
  if (!expected) {
    throw new Error('Expected WatDiv scale 10 or 100.');
  }
  const directory = resolve('generated');
  const marker = join(directory, 'watdiv-assets.json');
  const provenance = { revision, scale: Number(scale), archiveSha256: expected };
  try {
    if (await readFile(marker, 'utf8') === JSON.stringify(provenance) &&
      (await stat(join(directory, 'dataset.nt'))).size > 0 &&
      (await readdir(join(directory, 'queries'))).some(file => file.endsWith('.txt'))) {
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, 'watdiv-download-'));
  try {
    const archive = join(temporary, 'watdiv.zip');
    const url = `https://media.githubusercontent.com/media/comunica/comunica-performance-assets/${revision}/watdiv-${scale}.zip`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`WatDiv download failed: HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) {
      digest.update(chunk);
    }
    if (digest.digest('hex') !== expected) {
      throw new Error('WatDiv archive checksum mismatch.');
    }
    // Reuse exactly the RDF and query inputs from the HDT benchmarks, without their HDT output.
    const result = spawnSync('unzip', [ '-oq', archive, 'dataset.nt', 'queries/*', '-d', directory ], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw result.error || new Error('Could not extract the WatDiv dataset and queries.');
    }
    await writeFile(marker, JSON.stringify(provenance));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
