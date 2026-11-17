'use strict';
/* eslint-disable no-console, no-sync, unicorn/no-process-exit -- a command-line benchmark script */
// Run one query against one or more sources with the engine of a given checkout, in this process
// only, and print one JSON line: time to the first and the last result, the number of results, a
// digest of the result multiset (blank node labels abstracted), and how many queries of each kind
// reached the COTTAS files. The digest lets runs over different layouts be checked for equality.
//
// Usage: node run-query.js <engine-checkout> <queries.txt> <instance> <source,source,...> [run|plan]
// A source ending in .nt is loaded as N-Triples; any other is a COTTAS file.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [ checkout, queryFile, instance, sourceList, mode = 'run' ] = process.argv.slice(2);
const documentModule = require(path.join(checkout, 'packages/actor-query-source-identify-cottas/lib/CottasDocument.js'));
const METHODS = [ 'countPattern', 'searchBindings', 'countJoin', 'openJoin', 'openBoundJoin', 'openFilterJoin' ];
const stats = Object.fromEntries(METHODS.map(method => [ method, 0 ]));
const open = documentModule.openCottasDocument;
documentModule.openCottasDocument = async(...args) => {
  const document = await open(...args);
  for (const method of METHODS.filter(name => typeof document[name] === 'function')) {
    const original = document[method].bind(document);
    document[method] = async(...methodArgs) => {
      stats[method]++;
      return original(...methodArgs);
    };
  }
  return document;
};

const { QueryEngine } = require(path.join(checkout, 'engines/query-sparql-cottas/lib/index.js'));
const query = fs.readFileSync(queryFile, 'utf8').split(/\n\s*\n/u).map(text => text.trim()).filter(Boolean)[Number(instance)];
const sources = sourceList.split(',').map(value => value.endsWith('.nt') ?
    { type: 'serialized', value: fs.readFileSync(value, 'utf8'), mediaType: 'application/n-triples' } :
    { type: 'cottas', value });
const round = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'number' ? Math.round(item) : item));

(async() => {
  const engine = new QueryEngine();
  const start = performance.now();
  if (mode === 'plan') {
    const explained = await engine.explain(query, { sources }, 'physical');
    const joins = {};
    for (const line of String(explained.data).split('\n')) {
      const match = /^\s*(join-inner)\(([a-z-]+)\)/u.exec(line);
      if (match) {
        joins[match[2]] = (joins[match[2]] ?? 0) + 1;
      }
    }
    console.log(JSON.stringify(round({ ms: performance.now() - start, joins, stats })));
  } else {
    const stream = await engine.queryBindings(query, { sources });
    const rows = [];
    let first;
    await new Promise((resolve, reject) => {
      stream.on('data', (bindings) => {
        first ??= performance.now() - start;
        rows.push([ ...bindings ]
          .map(([ variable, term ]) => `${variable.value}=${term.termType === 'BlankNode' ? '_:' : term.value}`)
          .sort()
          .join(' '));
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const digest = crypto.createHash('sha1').update(rows.sort().join('\n')).digest('hex').slice(0, 12);
    console.log(JSON.stringify(round({ ms: performance.now() - start, first: first ?? null, results: rows.length, digest, stats })));
  }
  process.exit(0);
})().catch((error) => {
  console.log(JSON.stringify(round({ error: String(error?.message ?? error).slice(0, 300), stats })));
  process.exit(1);
});
