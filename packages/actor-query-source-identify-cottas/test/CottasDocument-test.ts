import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { DuckDBInstance } from '@duckdb/node-api';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { openCottasDocument } from '../lib/CottasDocument';

const DF = new DataFactory<RDF.BaseQuad>();
const BF = new BindingsFactory(DF);
const FIXTURE = resolve(__dirname, 'fixtures/example.cottas');

describe('CottasDocument', () => {
  let temporaryDirectory: string;
  let triplePath: string;
  let quadPath: string;
  let invalidSchemaPath: string;
  let extraColumnPath: string;
  let invalidTypePath: string;
  let invalidTermPath: string;
  let nullTermPath: string;

  beforeAll(async() => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'comunica-cottas-test-'));
    triplePath = join(temporaryDirectory, 'triples.cottas');
    quadPath = join(temporaryDirectory, 'quads.cottas');
    invalidSchemaPath = join(temporaryDirectory, 'invalid-schema.cottas');
    extraColumnPath = join(temporaryDirectory, 'extra-column.cottas');
    invalidTypePath = join(temporaryDirectory, 'invalid-type.cottas');
    invalidTermPath = join(temporaryDirectory, 'invalid-term.cottas');
    nullTermPath = join(temporaryDirectory, 'null-term.cottas');

    await createParquet(triplePath, 's VARCHAR, p VARCHAR, o VARCHAR', [
      [ '<urn:s1>', '<urn:p>', '"hello"@en' ],
      [ '_:blank', '<urn:p>', '"42"^^<http://www.w3.org/2001/XMLSchema#integer>' ],
      [ '<urn:same>', '<urn:p>', '<urn:same>' ],
      [ '<urn:different>', '<urn:p>', '<urn:other>' ],
      [ '<urn:escaped>', '<urn:p>', '"line\\n\\"quote"' ],
    ]);
    await createParquet(quadPath, 's VARCHAR, p VARCHAR, o VARCHAR, g VARCHAR', [
      [ '<urn:default>', '<urn:p>', '<urn:o>', null ],
      [ '<urn:named>', '<urn:p>', '<urn:o>', '<urn:g1>' ],
      [ '<urn:blank-graph>', '<urn:p>', '<urn:o>', '_:g' ],
    ]);
    await createParquet(invalidSchemaPath, 'subject VARCHAR, p VARCHAR, o VARCHAR', [
      [ '<urn:s>', '<urn:p>', '<urn:o>' ],
    ]);
    await createParquet(extraColumnPath, 's VARCHAR, p VARCHAR, o VARCHAR, extra VARCHAR', [
      [ '<urn:s>', '<urn:p>', '<urn:o>', 'extra' ],
    ]);
    await createParquet(invalidTypePath, 's INTEGER, p VARCHAR, o VARCHAR', [
      [ 1, '<urn:p>', '<urn:o>' ],
    ]);
    await createParquet(invalidTermPath, 's VARCHAR, p VARCHAR, o VARCHAR', [
      [ 'not an RDF term', '<urn:p>', '<urn:o>' ],
    ]);
    await createParquet(nullTermPath, 's VARCHAR, p VARCHAR, o VARCHAR', [
      [ null, '<urn:p>', '<urn:o>' ],
    ]);
  });

  afterAll(async() => {
    await rm(temporaryDirectory, { recursive: true });
  });

  it('opens the cottas-rs reference fixture and detects a triple table', async() => {
    const document = await openCottasDocument(FIXTURE, DF);
    expect(document.hasGraphColumn).toBe(false);
    await expect(document.countPattern(DF.variable('s'), DF.variable('p'), DF.variable('o')))
      .resolves.toEqual({ totalCount: 3, hasExactCount: true });
    await document.close();
  });

  it('resolves a relative local path and applies the default graph argument', async() => {
    const document = await openCottasDocument(relative(process.cwd(), FIXTURE), DF);
    const result = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      undefined,
      { offset: 0, limit: 1 },
    );
    expect(result.bindings).toHaveLength(1);
    await document.close();
  });

  it('pushes down constants and decodes all RDF term kinds', async() => {
    const document = await openCottasDocument(triplePath, DF);
    const result = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.namedNode('urn:p'),
      DF.variable('o'),
      DF.defaultGraph(),
      { offset: 0, limit: 10 },
    );
    expect(result.bindings).toHaveLength(5);
    expect(result.bindings[0].get(DF.variable('o'))).toEqual(DF.literal('hello', 'en'));
    expect(result.bindings[1].get(DF.variable('s'))).toEqual(DF.blankNode('blank'));
    expect(result.bindings[1].get(DF.variable('o'))).toEqual(DF.literal(
      '42',
      DF.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
    ));
    expect(result.bindings[4].get(DF.variable('o'))).toEqual(DF.literal('line\n"quote'));
    await document.close();
  });

  it('enforces repeated-variable equality in DuckDB', async() => {
    const document = await openCottasDocument(triplePath, DF);
    const repeated = DF.variable('term');
    await expect(document.countPattern(repeated, DF.namedNode('urn:p'), repeated))
      .resolves.toEqual({ totalCount: 1, hasExactCount: true });
    const { bindings } = await document.searchBindings(
      BF,
      repeated,
      DF.namedNode('urn:p'),
      repeated,
      DF.defaultGraph(),
      { offset: 0, limit: 10 },
    );
    expect(bindings).toHaveLength(1);
    expect([ ...bindings[0] ]).toHaveLength(1);
    expect(bindings[0].get(repeated)).toEqual(DF.namedNode('urn:same'));
    await document.close();
  });

  it('pages deterministically without duplicates', async() => {
    const document = await openCottasDocument(triplePath, DF);
    const pattern: [RDF.Term, RDF.Term, RDF.Term, RDF.Term] = [
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.defaultGraph(),
    ];
    const first = await document.searchBindings(BF, ...pattern, { offset: 0, limit: 2 });
    const second = await document.searchBindings(BF, ...pattern, { offset: 2, limit: 2 });
    const third = await document.searchBindings(BF, ...pattern, { offset: 4, limit: 2 });
    expect([ ...first.bindings, ...second.bindings, ...third.bindings ]).toHaveLength(5);
    expect(first.bindings[0].get(DF.variable('s'))).toEqual(DF.namedNode('urn:s1'));
    expect(third.bindings[0].get(DF.variable('s'))).toEqual(DF.namedNode('urn:escaped'));
    await document.close();
  });

  it('implements default, named, and variable graph matching', async() => {
    const document = await openCottasDocument(quadPath, DF);
    expect(document.hasGraphColumn).toBe(true);
    const allVariables: [RDF.Term, RDF.Term, RDF.Term] = [
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
    ];
    await expect(document.countPattern(...allVariables, DF.defaultGraph()))
      .resolves.toEqual({ totalCount: 1, hasExactCount: true });
    await expect(document.countPattern(...allVariables, DF.namedNode('urn:g1')))
      .resolves.toEqual({ totalCount: 1, hasExactCount: true });
    await expect(document.countPattern(...allVariables, DF.variable('g')))
      .resolves.toEqual({ totalCount: 2, hasExactCount: true });
    const { bindings } = await document.searchBindings(
      BF,
      ...allVariables,
      DF.variable('g'),
      { offset: 0, limit: 10 },
    );
    expect(bindings.map(binding => binding.get(DF.variable('g')))).toEqual([
      DF.namedNode('urn:g1'),
      DF.blankNode('g'),
    ]);
    await document.close();
  });

  it('returns no named-graph results for a triple table', async() => {
    const document = await openCottasDocument(triplePath, DF);
    await expect(document.countPattern(
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.namedNode('urn:g'),
    )).resolves.toEqual({ totalCount: 0, hasExactCount: true });
    await expect(document.searchBindings(
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.namedNode('urn:g'),
      { offset: 0, limit: 10 },
    )).resolves.toEqual({ bindings: []});
    await expect(document.countPattern(
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.variable('g'),
    )).resolves.toEqual({ totalCount: 0, hasExactCount: true });
    await document.close();
  });

  it.each([
    [ 'unexpected columns', () => openCottasDocument(invalidSchemaPath, DF), 'expected exactly the columns' ],
    [ 'extra columns', () => openCottasDocument(extraColumnPath, DF), 'expected exactly the columns' ],
    [ 'unexpected types', () => openCottasDocument(invalidTypePath, DF), 'column \'s\' must be VARCHAR' ],
    [ 'missing file', () => openCottasDocument(join(temporaryDirectory, 'missing.cottas'), DF), 'Unable to access' ],
    [ 'glob', () => openCottasDocument(join(temporaryDirectory, '*.cottas'), DF), 'globs are not supported' ],
    [ 'empty path', () => openCottasDocument('', DF), 'one local file path' ],
    [ 'URL', () => openCottasDocument('https://example.org/data.cottas', DF), 'URLs are not supported' ],
    [ 'directory', () => openCottasDocument(temporaryDirectory, DF), 'must be a regular file' ],
  ])('rejects %s with an actionable error', async(_label, open, expected) => {
    await expect(open()).rejects.toThrow(expected);
  });

  it('reports invalid RDF term encoding while reading', async() => {
    const document = await openCottasDocument(invalidTermPath, DF);
    await expect(document.searchBindings(
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.defaultGraph(),
      { offset: 0, limit: 1 },
    )).rejects.toThrow('Invalid RDF term encoding');
    await document.close();
  });

  it('reports null required RDF terms while reading', async() => {
    const document = await openCottasDocument(nullTermPath, DF);
    await expect(document.searchBindings(
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.defaultGraph(),
      { offset: 0, limit: 1 },
    )).rejects.toThrow('non-string or null \'s\'');
    await document.close();
  });

  it('validates page bounds and closes idempotently', async() => {
    const document = await openCottasDocument(FIXTURE, DF);
    await expect(document.searchBindings(
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.defaultGraph(),
      { offset: -1, limit: 0 },
    )).rejects.toThrow('offset must be non-negative');
    await document.close();
    await document.close();
    await expect(document.countPattern(DF.variable('s'), DF.variable('p'), DF.variable('o')))
      .rejects.toThrow('is closed');
  });
});

async function createParquet(path: string, schema: string, rows: unknown[][]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE data (${schema})`);
    for (const row of rows) {
      const placeholders = row.map((_value, index) => `$value${index}`).join(', ');
      await connection.run(
        `INSERT INTO data VALUES (${placeholders})`,
        Object.fromEntries(row.map((value, index) => [ `value${index}`, value ])),
      );
    }
    await connection.run('COPY data TO $path (FORMAT PARQUET)', { path });
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
