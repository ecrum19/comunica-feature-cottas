const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SparqlBenchmarkRunner } = require('sparql-benchmark-runner');

test('the benchmark client leaves Content-Length to fetch and reads SPARQL results', async(t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async(url, init) => {
    requests++;
    assert.equal(url, 'http://benchmark.invalid/sparql');
    // Fetch-sparql-endpoint 5 sets this header, which fails with the Undici dispatcher loaded by JBR.
    assert.equal(init.headers.has('Content-Length'), false);
    assert.equal(init.body.get('query'), 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');
    return new Response(JSON.stringify({
      head: { vars: [ 's' ]},
      results: { bindings: [{ s: { type: 'uri', value: 'urn:subject' }}]},
    }), { headers: { 'content-type': 'application/sparql-results+json' }});
  });
  const runner = new SparqlBenchmarkRunner({
    endpoint: 'http://benchmark.invalid/sparql',
    querySets: {},
    replication: 1,
    warmup: 0,
  });
  const result = await runner.executeQuery('smoke', '0', 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');
  assert.equal(requests, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.results, 1);
});
