import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { QueryEngine } from '../lib/QueryEngine';

const FIXTURE = resolve(
  __dirname,
  '../../../packages/actor-query-source-identify-cottas/test/fixtures/example.cottas',
);
const SOURCE = { sources: [{ type: 'cottas', value: FIXTURE }]};

describe('QueryEngine', () => {
  let engine: QueryEngine;
  let temporaryDirectory: string;
  let quadFixture: string;
  let encodingFixture: string;

  beforeAll(async() => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'comunica-cottas-engine-test-'));
    quadFixture = join(temporaryDirectory, 'quads.cottas');
    encodingFixture = join(temporaryDirectory, 'encodings.cottas');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await connection.run('CREATE TABLE data (s VARCHAR, p VARCHAR, o VARCHAR, g VARCHAR)');
      await connection.run(`
        INSERT INTO data VALUES
          ('<urn:default>', '<urn:label>', '"default"', NULL),
          ('<urn:named>', '<urn:label>', '"bonjour"@fr', '<urn:g>'),
          ('<urn:same>', '<urn:same>', '<urn:o>', '<urn:g>')
      `);
      await connection.run('COPY data TO $path (FORMAT PARQUET)', { path: quadFixture });
      await connection.run('CREATE TABLE encodings (s VARCHAR, p VARCHAR, o VARCHAR)');
      await connection.run(`
        INSERT INTO encodings VALUES
          ('<urn:typed>', '<urn:p>', '"plain"^^<http://www.w3.org/2001/XMLSchema#string>'),
          ('<urn:simple>', '<urn:p>', '"plain"'),
          ('<urn:upper-tag>', '<urn:lang>', '"hi"@EN-GB')
      `);
      await connection.run('COPY encodings TO $path (FORMAT PARQUET)', { path: encodingFixture });
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  beforeEach(() => {
    engine = new QueryEngine();
  });

  afterAll(async() => {
    await rm(temporaryDirectory, { recursive: true });
  });

  it('evaluates SELECT and joins over a real COTTAS source', async() => {
    const result = await engine.queryBindings(`
      SELECT ?person ?friend ?next WHERE {
        ?person <http://example.org/knows> ?friend.
        ?friend <http://example.org/knows> ?next.
      }
      ORDER BY ?person
    `, SOURCE);
    const rows = await result.toArray();
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.get('person')?.value)).toEqual([
      'http://example.org/Alice',
      'http://example.org/Bob',
      'http://example.org/Charlie',
    ]);
    expect(rows[0].get('next')?.value).toBe('http://example.org/Charlie');
  });

  it('evaluates ASK over a real COTTAS source', async() => {
    await expect(engine.queryBoolean(`
      ASK {
        <http://example.org/Alice>
          <http://example.org/knows>
          <http://example.org/Bob>.
      }
    `, SOURCE)).resolves.toBe(true);
  });

  it('evaluates CONSTRUCT over a real COTTAS source', async() => {
    const result = await engine.queryQuads(`
      CONSTRUCT { ?friend <urn:knownBy> ?person }
      WHERE { ?person <http://example.org/knows> ?friend }
    `, SOURCE);
    const quads = await result.toArray();
    expect(quads).toHaveLength(3);
    expect(quads[0].predicate.value).toBe('urn:knownBy');
  });

  it('returns an empty result for an unmatched pattern', async() => {
    const result = await engine.queryBindings(
      'SELECT * WHERE { ?s <urn:missing> ?o }',
      SOURCE,
    );
    await expect(result.toArray()).resolves.toEqual([]);
  });

  it('evaluates named graphs, literals, and repeated variables over a quad COTTAS source', async() => {
    const source = { sources: [{ type: 'cottas', value: quadFixture }]};
    const namedResult = await engine.queryBindings(`
      SELECT ?s ?g ?label WHERE {
        GRAPH ?g { ?s <urn:label> ?label }
      }
    `, source);
    const namedRows = await namedResult.toArray();
    expect(namedRows).toHaveLength(1);
    expect(namedRows[0].get('s')?.value).toBe('urn:named');
    expect(namedRows[0].get('g')?.value).toBe('urn:g');
    expect(namedRows[0].get('label')?.language).toBe('fr');

    const repeatedResult = await engine.queryBindings(`
      SELECT ?term ?o WHERE {
        GRAPH <urn:g> { ?term ?term ?o }
      }
    `, source);
    const repeatedRows = await repeatedResult.toArray();
    expect(repeatedRows).toHaveLength(1);
    expect(repeatedRows[0].get('term')?.value).toBe('urn:same');
  });

  it('matches literals stored in any of their legal N-Triples encodings', async() => {
    const source = { sources: [{ type: 'cottas', value: encodingFixture }]};

    // A simple literal and an xsd:string-typed literal denote the same RDF term.
    const plain = await engine.queryBindings('SELECT ?s WHERE { ?s <urn:p> "plain" } ORDER BY ?s', source);
    await expect(plain.toArray()).resolves.toHaveLength(2);

    // RDF 1.1 compares language tags case-insensitively.
    const language = await engine.queryBindings('SELECT ?s WHERE { ?s <urn:lang> "hi"@en-GB }', source);
    const rows = await language.toArray();
    expect(rows.map(row => row.get('s')?.value)).toEqual([ 'urn:upper-tag' ]);
  });

  it('reads the default graph as the union of all graphs when requested', async() => {
    const sources = [{ type: 'cottas', value: quadFixture }];

    const scoped = await engine.queryBindings('SELECT * WHERE { ?s ?p ?o }', { sources });
    await expect(scoped.toArray()).resolves.toHaveLength(1);

    const union = await engine.queryBindings(
      'SELECT * WHERE { ?s ?p ?o }',
      { sources, unionDefaultGraph: true },
    );
    await expect(union.toArray()).resolves.toHaveLength(3);
  });
});
