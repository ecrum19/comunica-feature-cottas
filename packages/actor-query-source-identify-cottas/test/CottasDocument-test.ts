import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { DuckDBInstance } from '@duckdb/node-api';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { CardinalityCache, openCottasDocument } from '../lib/CottasDocument';

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
  let encodingsPath: string;
  let indexedPath: string;

  beforeAll(async() => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'comunica-cottas-test-'));
    triplePath = join(temporaryDirectory, 'triples.cottas');
    quadPath = join(temporaryDirectory, 'quads.cottas');
    invalidSchemaPath = join(temporaryDirectory, 'invalid-schema.cottas');
    extraColumnPath = join(temporaryDirectory, 'extra-column.cottas');
    invalidTypePath = join(temporaryDirectory, 'invalid-type.cottas');
    invalidTermPath = join(temporaryDirectory, 'invalid-term.cottas');
    nullTermPath = join(temporaryDirectory, 'null-term.cottas');
    encodingsPath = join(temporaryDirectory, 'encodings.cottas');
    indexedPath = join(temporaryDirectory, 'indexed.cottas');

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
    // The same RDF term has more than one legal N-Triples encoding.
    await createParquet(encodingsPath, 's VARCHAR, p VARCHAR, o VARCHAR', [
      [ '<urn:typed>', '<urn:p>', '"plain"^^<http://www.w3.org/2001/XMLSchema#string>' ],
      [ '<urn:simple>', '<urn:p>', '"plain"' ],
      [ '<urn:upper-tag>', '<urn:lang>', '"hi"@EN-GB' ],
      [ '<urn:lower-tag>', '<urn:lang>', '"hi"@en-gb' ],
      [ '<urn:upper-lexical>', '<urn:lang>', '"HI"@en-gb' ],
      [ '<urn:raw-astral>', '<urn:astral>', '"a \u{1F600}"' ],
      [ '<urn:escaped-astral>', '<urn:astral>', '"a \\U0001f600"' ],
      [ '<urn:literal-backslash>', '<urn:astral>', '"a \\\\U0001f600"' ],
      [ '<urn:raw-control>', '<urn:control>', `"x${String.fromCodePoint(1)}"` ],
      [ '<urn:escaped-control>', '<urn:control>', '"x\\u0001"' ],
    ]);
    // The same three triples in three row orders, as the benchmark converter emits them.
    const triples: unknown[][] = [
      [ '<urn:s1>', '<urn:p2>', '<urn:o1>' ],
      [ '<urn:s2>', '<urn:p1>', '<urn:o9>' ],
      [ '<urn:s3>', '<urn:p1>', '<urn:o5>' ],
    ];
    const by = (...order: number[]): unknown[][] =>
      [ ...triples ].sort((a, b) => order
        .map(i => String(a[i]).localeCompare(String(b[i])))
        .find(comparison => comparison !== 0) ?? 0);
    const spo = 's VARCHAR, p VARCHAR, o VARCHAR';
    await createParquet(indexedPath, spo, by(0, 1, 2));
    await createParquet(join(temporaryDirectory, 'indexed.posg.cottas'), spo, by(1, 2, 0));
    await createParquet(join(temporaryDirectory, 'indexed.ospg.cottas'), spo, by(2, 0, 1));
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

  it('matches simple and xsd:string-typed encodings of the same literal', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    const pattern: [RDF.Term, RDF.Term, RDF.Term, RDF.Term] = [
      DF.variable('s'),
      DF.namedNode('urn:p'),
      DF.literal('plain'),
      DF.defaultGraph(),
    ];
    await expect(document.countPattern(...pattern))
      .resolves.toEqual({ totalCount: 2, hasExactCount: true });
    const { bindings } = await document.searchBindings(BF, ...pattern, { offset: 0, limit: 10 });
    expect(bindings.map(binding => binding.get(DF.variable('s'))!.value).sort())
      .toEqual([ 'urn:simple', 'urn:typed' ]);
    await document.close();
  });

  it('matches an explicitly xsd:string-typed constant against both encodings', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    await expect(document.countPattern(
      DF.variable('s'),
      DF.namedNode('urn:p'),
      DF.literal('plain', DF.namedNode('http://www.w3.org/2001/XMLSchema#string')),
    )).resolves.toEqual({ totalCount: 2, hasExactCount: true });
    await document.close();
  });

  it('compares language tags case-insensitively', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    for (const tag of [ 'en-gb', 'EN-GB', 'en-GB' ]) {
      const { bindings } = await document.searchBindings(
        BF,
        DF.variable('s'),
        DF.namedNode('urn:lang'),
        DF.literal('hi', tag),
        DF.defaultGraph(),
        { offset: 0, limit: 10 },
      );
      expect(bindings.map(binding => binding.get(DF.variable('s'))!.value).sort())
        .toEqual([ 'urn:lower-tag', 'urn:upper-tag' ]);
    }
    await document.close();
  });

  it('keeps the lexical form case-sensitive while matching language tags', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    const { bindings } = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.namedNode('urn:lang'),
      DF.literal('HI', 'en-gb'),
      DF.defaultGraph(),
      { offset: 0, limit: 10 },
    );
    expect(bindings.map(binding => binding.get(DF.variable('s'))!.value)).toEqual([ 'urn:upper-lexical' ]);
    await document.close();
  });

  it('matches raw and escaped encodings of astral characters', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    // N3 serializes astral characters as \U0001f600; COTTAS files usually store them raw.
    const { bindings } = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.namedNode('urn:astral'),
      DF.literal('a \u{1F600}'),
      DF.defaultGraph(),
      { offset: 0, limit: 10 },
    );
    expect(bindings.map(binding => binding.get(DF.variable('s'))!.value).sort())
      .toEqual([ 'urn:escaped-astral', 'urn:raw-astral' ]);
    await document.close();
  });

  it('matches raw and escaped encodings of control characters', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    // N3 serializes control characters with the short \u0001 escape.
    const { bindings } = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.namedNode('urn:control'),
      DF.literal(`x${String.fromCodePoint(1)}`),
      DF.defaultGraph(),
      { offset: 0, limit: 10 },
    );
    expect(bindings.map(binding => binding.get(DF.variable('s'))!.value).sort())
      .toEqual([ 'urn:escaped-control', 'urn:raw-control' ]);
    await document.close();
  });

  it('does not mistake an escaped backslash for a character escape', async() => {
    const document = await openCottasDocument(encodingsPath, DF);
    const { bindings } = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.namedNode('urn:astral'),
      // A literal whose lexical form really is a backslash followed by "U0001f600".
      DF.literal('a \\U0001f600'),
      DF.defaultGraph(),
      { offset: 0, limit: 10 },
    );
    expect(bindings.map(binding => binding.get(DF.variable('s'))!.value)).toEqual([ 'urn:literal-backslash' ]);
    await document.close();
  });

  it('treats the default graph as the union of all graphs when asked', async() => {
    const document = await openCottasDocument(quadPath, DF);
    const allVariables: [RDF.Term, RDF.Term, RDF.Term] = [
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
    ];
    await expect(document.countPattern(...allVariables, DF.defaultGraph(), { unionDefaultGraph: true }))
      .resolves.toEqual({ totalCount: 3, hasExactCount: true });
    const { bindings } = await document.searchBindings(
      BF,
      ...allVariables,
      DF.defaultGraph(),
      { offset: 0, limit: 10, unionDefaultGraph: true },
    );
    expect(bindings.map(binding => binding.get(DF.variable('s'))!.value)).toEqual([
      'urn:default',
      'urn:named',
      'urn:blank-graph',
    ]);
    await document.close();
  });

  it('lets a graph variable range over the default graph under union semantics', async() => {
    const document = await openCottasDocument(quadPath, DF);
    const { bindings } = await document.searchBindings(
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      DF.variable('g'),
      { offset: 0, limit: 10, unionDefaultGraph: true },
    );
    expect(bindings.map(binding => binding.get(DF.variable('g'))!.termType)).toEqual([
      'DefaultGraph',
      'NamedNode',
      'BlankNode',
    ]);
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

  describe('index selection', () => {
    it('answers each pattern shape from the index whose leading components are bound', async() => {
      const document = await openCottasDocument(indexedPath, DF);
      const used: string[] = [];
      const real = (<any> document).connection.runAndReadAll.bind((<any> document).connection);
      jest.spyOn((<any> document).connection, 'runAndReadAll').mockImplementation((...args: any[]) => {
        used.push(String(args[1].path).replace(`${temporaryDirectory}/`, ''));
        return real(...args);
      });

      const S = DF.namedNode('urn:s1');
      const P = DF.namedNode('urn:p1');
      const O = DF.namedNode('urn:o5');
      const v = DF.variable('v');
      for (const pattern of <[RDF.Term, RDF.Term, RDF.Term][]>[
        [ S, v, v ],
        [ v, P, v ],
        [ v, v, O ],
        [ S, P, v ],
        [ v, P, O ],
        [ O, v, v ],
        [ v, v, v ],
      ]) {
        await document.countPattern(...pattern);
      }
      expect(used).toEqual([
        'indexed.cottas', // S bound
        'indexed.posg.cottas', // P bound
        'indexed.ospg.cottas', // O bound
        'indexed.cottas', // S and p bound
        'indexed.posg.cottas', // P and o bound
        'indexed.cottas', // O as a subject term still binds s
        'indexed.cottas', // Nothing bound, primary
      ]);
      await document.close();
    });

    it('returns the same solutions whichever index answers the pattern', async() => {
      const document = await openCottasDocument(indexedPath, DF);
      const subjectsFor = async(pattern: [RDF.Term, RDF.Term, RDF.Term]): Promise<string[]> => {
        const { bindings } = await document.searchBindings(BF, ...pattern, DF.defaultGraph(), { offset: 0, limit: 10 });
        return bindings.map(binding => binding.get(DF.variable('s'))!.value).sort();
      };
      await expect(subjectsFor([ DF.variable('s'), DF.namedNode('urn:p1'), DF.variable('o') ]))
        .resolves.toEqual([ 'urn:s2', 'urn:s3' ]);
      await expect(subjectsFor([ DF.variable('s'), DF.variable('p'), DF.namedNode('urn:o5') ]))
        .resolves.toEqual([ 'urn:s3' ]);
      await expect(document.countPattern(DF.variable('s'), DF.variable('p'), DF.variable('o')))
        .resolves.toEqual({ totalCount: 3, hasExactCount: true });
      await document.close();
    });

    it('uses only the primary file when no sibling indexes are present', async() => {
      const document = await openCottasDocument(triplePath, DF);
      const used: string[] = [];
      const real = (<any> document).connection.runAndReadAll.bind((<any> document).connection);
      jest.spyOn((<any> document).connection, 'runAndReadAll').mockImplementation((...args: any[]) => {
        used.push(String(args[1].path));
        return real(...args);
      });
      await document.countPattern(DF.variable('s'), DF.namedNode('urn:p'), DF.variable('o'));
      expect(used).toEqual([ triplePath ]);
      await document.close();
    });

    it('uses whichever sibling indexes happen to be present', async() => {
      const primary = join(temporaryDirectory, 'partial.cottas');
      const rows: unknown[][] = [[ '<urn:s1>', '<urn:p1>', '<urn:o1>' ], [ '<urn:s2>', '<urn:p2>', '<urn:o2>' ]];
      await createParquet(primary, 's VARCHAR, p VARCHAR, o VARCHAR', rows);
      // Only the object-ordered sibling exists; the predicate-ordered one does not.
      await createParquet(join(temporaryDirectory, 'partial.ospg.cottas'), 's VARCHAR, p VARCHAR, o VARCHAR', rows);
      const document = await openCottasDocument(primary, DF);
      const used: string[] = [];
      const real = (<any> document).connection.runAndReadAll.bind((<any> document).connection);
      jest.spyOn((<any> document).connection, 'runAndReadAll').mockImplementation((...args: any[]) => {
        used.push(String(args[1].path).replace(`${temporaryDirectory}/`, ''));
        return real(...args);
      });
      await document.countPattern(DF.variable('s'), DF.variable('p'), DF.namedNode('urn:o2'));
      await document.countPattern(DF.variable('s'), DF.namedNode('urn:p1'), DF.variable('o'));
      // Object-bound uses the sibling; predicate-bound falls back to the primary.
      expect(used).toEqual([ 'partial.ospg.cottas', 'partial.cottas' ]);
      await document.close();
    });

    it('rejects a sibling index whose columns do not match', async() => {
      const primary = join(temporaryDirectory, 'mismatch.cottas');
      await createParquet(primary, 's VARCHAR, p VARCHAR, o VARCHAR', [[ '<urn:s>', '<urn:p>', '<urn:o>' ]]);
      await createParquet(
        join(temporaryDirectory, 'mismatch.posg.cottas'),
        's VARCHAR, p VARCHAR, o VARCHAR, g VARCHAR',
        [[ '<urn:s>', '<urn:p>', '<urn:o>', null ]],
      );
      await expect(openCottasDocument(primary, DF)).rejects.toThrow('but the primary file has');
    });
  });

  describe('cardinality caching', () => {
    it('answers a repeated pattern without querying DuckDB again', async() => {
      const document = await openCottasDocument(triplePath, DF);
      const query = jest.spyOn((<any> document).connection, 'runAndReadAll');
      const pattern: [RDF.Term, RDF.Term, RDF.Term] = [
        DF.variable('s'),
        DF.namedNode('urn:p'),
        DF.variable('o'),
      ];
      await expect(document.countPattern(...pattern)).resolves.toEqual({ totalCount: 5, hasExactCount: true });
      await expect(document.countPattern(...pattern)).resolves.toEqual({ totalCount: 5, hasExactCount: true });
      expect(query).toHaveBeenCalledTimes(1);
      await document.close();
    });

    it('collapses concurrent probes for the same pattern onto one query', async() => {
      const document = await openCottasDocument(triplePath, DF);
      const query = jest.spyOn((<any> document).connection, 'runAndReadAll');
      const counts = await Promise.all(Array.from({ length: 8 }, () =>
        document.countPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'))));
      expect(counts.every(count => count.totalCount === 5)).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      await document.close();
    });

    it('keeps patterns with different cardinalities apart', async() => {
      const document = await openCottasDocument(triplePath, DF);
      const repeated = DF.variable('term');
      // A repeated variable adds an equality condition, so it must not share the all-variables entry.
      await expect(document.countPattern(DF.variable('s'), DF.variable('p'), DF.variable('o')))
        .resolves.toEqual({ totalCount: 5, hasExactCount: true });
      await expect(document.countPattern(repeated, DF.namedNode('urn:p'), repeated))
        .resolves.toEqual({ totalCount: 1, hasExactCount: true });
      await expect(document.countPattern(DF.variable('s'), DF.namedNode('urn:p'), DF.variable('o')))
        .resolves.toEqual({ totalCount: 5, hasExactCount: true });
      await document.close();
    });

    it('keys blank node and named node terms apart', async() => {
      const document = await openCottasDocument(triplePath, DF);
      // The fixture stores `_:blank <urn:p> "42"^^xsd:integer`.
      await expect(document.countPattern(DF.blankNode('blank'), DF.namedNode('urn:p'), DF.variable('o')))
        .resolves.toEqual({ totalCount: 1, hasExactCount: true });
      await expect(document.countPattern(DF.namedNode('blank'), DF.namedNode('urn:p'), DF.variable('o')))
        .resolves.toEqual({ totalCount: 0, hasExactCount: true });
      await document.close();
    });

    it('keeps graph terms and union default graph semantics apart', async() => {
      const document = await openCottasDocument(quadPath, DF);
      const spo: [RDF.Term, RDF.Term, RDF.Term] = [
        DF.variable('s'),
        DF.variable('p'),
        DF.variable('o'),
      ];
      await expect(document.countPattern(...spo, DF.defaultGraph()))
        .resolves.toEqual({ totalCount: 1, hasExactCount: true });
      await expect(document.countPattern(...spo, DF.variable('g')))
        .resolves.toEqual({ totalCount: 2, hasExactCount: true });
      await expect(document.countPattern(...spo, DF.defaultGraph(), { unionDefaultGraph: true }))
        .resolves.toEqual({ totalCount: 3, hasExactCount: true });
      await document.close();
    });

    it('does not remember a failed lookup', async() => {
      const document = await openCottasDocument(triplePath, DF);
      const failure = new Error('DuckDB unavailable');
      const query = jest.spyOn((<any> document).connection, 'runAndReadAll')
        .mockRejectedValueOnce(failure);
      const pattern: [RDF.Term, RDF.Term, RDF.Term] = [
        DF.variable('s'),
        DF.variable('p'),
        DF.variable('o'),
      ];
      await expect(document.countPattern(...pattern)).rejects.toBe(failure);
      await expect(document.countPattern(...pattern))
        .resolves.toEqual({ totalCount: 5, hasExactCount: true });
      expect(query).toHaveBeenCalledTimes(2);
      await document.close();
    });
  });

  describe('CardinalityCache', () => {
    it('evicts the least recently used entry beyond its bound', async() => {
      const cache = new CardinalityCache<number>(2);
      cache.set('a', Promise.resolve(1));
      cache.set('b', Promise.resolve(2));
      // Touching 'a' makes 'b' the least recently used entry.
      await expect(cache.get('a')).resolves.toBe(1);
      cache.set('c', Promise.resolve(3));
      expect(cache.get('b')).toBeUndefined();
      await expect(cache.get('a')).resolves.toBe(1);
      await expect(cache.get('c')).resolves.toBe(3);
    });

    it('leaves a replacement entry alone when the entry it replaced fails', async() => {
      const cache = new CardinalityCache<number>(4);
      const failing = Promise.reject(new Error('stale'));
      cache.set('k', failing);
      cache.set('k', Promise.resolve(7));
      await expect(failing).rejects.toThrow('stale');
      await expect(cache.get('k')).resolves.toBe(7);
    });

    it('drops rejected entries and can be cleared', async() => {
      const cache = new CardinalityCache<number>(4);
      const rejected = Promise.reject(new Error('nope'));
      cache.set('bad', rejected);
      await expect(rejected).rejects.toThrow('nope');
      expect(cache.get('bad')).toBeUndefined();

      cache.set('good', Promise.resolve(1));
      cache.clear();
      expect(cache.get('good')).toBeUndefined();
    });
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
