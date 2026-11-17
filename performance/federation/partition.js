'use strict';
/* eslint-disable no-console, no-sync, unicorn/no-process-exit -- a command-line benchmark script */
// Split a COTTAS dataset into N parts, once by a hash of the subject and once by a hash of the
// predicate. Every part is written in all three index orders, keeping the source's row-group size.
// With --ntriples the last part of the subject split is also written as N-Triples, so a federation
// can mix a COTTAS file with a source Comunica loads into memory.
//
// Usage: node partition.js <generated-dir> <out-root> <N> [--ntriples]
const fs = require('node:fs');
const path = require('node:path');

const { DuckDBInstance } = require(require.resolve('@duckdb/node-api', { paths: [ path.join(__dirname, '../..') ]}));

const [ generated, outRoot, parts = '2', flag ] = process.argv.slice(2);
const N = Number(parts);
const ORDERS = [[ '', 's, p, o' ], [ '.posg', 'p, o, s' ], [ '.ospg', 'o, s, p' ]];

(async() => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const primary = path.join(generated, 'dataset.cottas');
  const rowGroup = Number((await connection.runAndReadAll(
    'SELECT max(row_group_num_rows) AS r FROM parquet_metadata($path)',
    { path: primary },
  )).getRowObjectsJS()[0].r);
  for (const [ scheme, column ] of [[ 'subj', 's' ], [ 'pred', 'p' ]]) {
    const dir = path.join(outRoot, `${scheme}${N}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < N; k++) {
      for (const [ suffix, keys ] of ORDERS) {
        await connection.run(`COPY (SELECT s, p, o FROM read_parquet($source)
          WHERE hash(${column}) % ${N} = ${k} ORDER BY ${keys})
          TO '${path.join(dir, `part${k}${suffix}.cottas`)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${rowGroup})`, { source: path.join(generated, `dataset${suffix}.cottas`) });
      }
      const row = (await connection.runAndReadAll(
        'SELECT count(*)::BIGINT AS n FROM read_parquet($path)',
        { path: path.join(dir, `part${k}.cottas`) },
      )).getRowObjectsJS()[0];
      console.log(`${scheme}${N}/part${k}: ${row.n} triples`);
    }
    if (flag === '--ntriples' && scheme === 'subj') {
      const target = path.join(dir, `part${N - 1}.nt`);
      const out = fs.createWriteStream(target);
      const result = await connection.stream('SELECT s, p, o FROM read_parquet($path)', {
        path: path.join(dir, `part${N - 1}.cottas`),
      });
      for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
        const lines = chunk.getRows().map(([ s, p, o ]) => `${s} ${p} ${o} .\n`).join('');
        if (!out.write(lines)) {
          await new Promise(resolve => out.once('drain', resolve));
        }
      }
      await new Promise(resolve => out.end(resolve));
      console.log(`${scheme}${N}/part${N - 1}.nt written`);
    }
  }
  connection.closeSync();
  instance.closeSync();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
