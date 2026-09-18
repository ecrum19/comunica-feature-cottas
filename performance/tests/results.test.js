const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compareResults, validateResults } = require('../scripts/summarize-results');

const metric = (name, value) => ({ name, unit: 'ms', value });

test('compares measurements by name, independently of their order', () => {
  const result = compareResults([ metric('B', 200), metric('A', 50) ], [ metric('A', 100), metric('B', 100) ]);
  assert.deepEqual(result.map(entry => entry.ratio), [ 2, 0.5 ]);
});

test('rejects missing or mismatched measurements', () => {
  assert.throws(() => validateResults([]), /No benchmark/u);
  assert.throws(() => compareResults([ metric('A', 1) ], [ metric('B', 1) ]), /do not match/u);
  assert.throws(() => compareResults([ metric('A', 1) ], [ metric('A', 1), metric('B', 1) ]), /do not match/u);
});

test('rejects query errors instead of treating failed queries as fast measurements', () => {
  assert.throws(() => validateResults([{ ...metric('A', 0), extra: 'Results: [0]; Error: [false,true]' }]), /query failed/u);
});

test('rejects invalid timings and duplicate metrics', () => {
  for (const value of [ null, Number.NaN, Number.POSITIVE_INFINITY, -1 ]) {
    assert.throws(() => validateResults([ metric('A', value) ]), /Invalid/u);
  }
  assert.throws(() => validateResults([ metric('A', 1), metric('A', 2) ]), /Invalid/u);
});

test('handles zero-time baselines explicitly', () => {
  assert.equal(compareResults([ metric('A', 0) ], [ metric('A', 0) ])[0].ratio, 1);
  assert.equal(compareResults([ metric('A', 1) ], [ metric('A', 0) ])[0].ratio, Number.POSITIVE_INFINITY);
});
