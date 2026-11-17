import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bindings } from '@comunica/types';
import { DuckDBInstance } from '@duckdb/node-api';
import { QueryEngine } from '../lib/QueryEngine';

const EX = 'http://example.org/';
const KNOWS = `<${EX}knows>`;
const NAME = `<${EX}name>`;
const AGE = `<${EX}age>`;
const PEOPLE = 60;

type Triple = [string, string, string];

/**
 * A small social graph. Every subject's triples, blank nodes included, live in one partition of the
 * subject split, so federating over that split must give the same answers as the single file.
 */
function dataset(): Triple[] {
  const triples: Triple[] = [];
  for (let i = 0; i < PEOPLE; i++) {
    triples.push([ `<${EX}p${i}>`, KNOWS, `<${EX}p${(i * 7 + 3) % PEOPLE}>` ]);
    triples.push([ `<${EX}p${i}>`, NAME, `"Person ${i}"` ]);
    if (i % 3 === 0) {
      triples.push([ `<${EX}p${i}>`, AGE, `"${20 + i}"^^<http://www.w3.org/2001/XMLSchema#integer>` ]);
    }
  }
  triples.push([ `<${EX}p1>`, KNOWS, '_:anon' ]);
  triples.push([ '_:anon', NAME, '"Anon"@en' ]);
  triples.push([ '_:anon', KNOWS, `<${EX}p2>` ]);
  return triples;
}

/** The partition of a subject; the blank node goes with p1, the subject of the triple naming it. */
function partOf(subject: string): number {
  return subject.startsWith('_:') ? 1 : Number(/p(\d+)>/u.exec(subject)![1]) % 2;
}

async function writeCottas(path: string, triples: Triple[]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('CREATE TABLE data (s VARCHAR, p VARCHAR, o VARCHAR)');
    for (const [ s, p, o ] of triples) {
      await connection.run('INSERT INTO data VALUES ($s, $p, $o)', { s, p, o });
    }
    await connection.run('COPY (SELECT * FROM data ORDER BY s, p, o) TO $path (FORMAT PARQUET)', { path });
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Order-independent rendering of a result multiset, with blank node labels abstracted away. */
function render(rows: Bindings[]): string[] {
  return rows.map(row => [ ...row ]
    .map(([ variable, term ]) => `${variable.value}=${term.termType === 'BlankNode' ? '_:' : term.value}`)
    .sort()
    .join(' ')).sort();
}

const QUERIES: Record<string, string> = {
  path: `SELECT * WHERE { ?a <${EX}knows> ?b . ?b <${EX}knows> ?c . ?c <${EX}name> ?n }`,
  star: `SELECT * WHERE { ?a <${EX}name> ?n ; <${EX}age> ?g ; <${EX}knows> ?b }`,
  selective: `SELECT * WHERE { ?a <${EX}name> "Person 1" ; <${EX}knows> ?b . ?b <${EX}name> ?n }`,
  optional: `SELECT * WHERE { ?a <${EX}knows> ?b . OPTIONAL { ?b <${EX}age> ?g } }`,
};

describe('QueryEngine over several sources', () => {
  let engine: QueryEngine;
  let directory: string;
  let full: string;
  let bySubject: string[];
  let byPredicate: string[];
  let nTriples: string;

  beforeAll(async() => {
    directory = await mkdtemp(join(tmpdir(), 'comunica-cottas-federation-test-'));
    const triples = dataset();
    full = join(directory, 'full.cottas');
    bySubject = [ join(directory, 'subject0.cottas'), join(directory, 'subject1.cottas') ];
    byPredicate = [ join(directory, 'knows.cottas'), join(directory, 'other.cottas') ];
    await writeCottas(full, triples);
    await writeCottas(bySubject[0], triples.filter(([ s ]) => partOf(s) === 0));
    await writeCottas(bySubject[1], triples.filter(([ s ]) => partOf(s) === 1));
    // Without blank nodes, which would otherwise be split across two files.
    const named = triples.filter(triple => !triple.some(term => term.startsWith('_:')));
    await writeCottas(byPredicate[0], named.filter(([ , p ]) => p === KNOWS));
    await writeCottas(byPredicate[1], named.filter(([ , p ]) => p !== KNOWS));
    nTriples = triples.filter(([ s ]) => partOf(s) === 1).map(triple => `${triple.join(' ')} .`).join('\n');
  });

  beforeEach(() => {
    engine = new QueryEngine();
  });

  afterAll(async() => {
    await rm(directory, { recursive: true });
  });

  const cottas = (...paths: string[]) => paths.map(value => ({ type: 'cottas', value }));
  const answer = async(query: string, sources: any[]): Promise<Bindings[]> =>
    (await engine.queryBindings(query, <any> { sources })).toArray();
  const physicalPlan = async(query: string, sources: any[]): Promise<string> =>
    JSON.stringify((await engine.explain(query, <any> { sources }, 'physical')).data);

  it.each(Object.entries(QUERIES))('answers the %s query over a subject split as over one file', async(_, query) => {
    const expected = render(await answer(query, cottas(full)));
    expect(expected.length).toBeGreaterThan(0);
    expect(render(await answer(query, cottas(...bySubject)))).toEqual(expected);
  });

  it.each(Object.entries(QUERIES))('answers the %s query over a predicate split like one file', async(_, query) => {
    const named = (rows: Bindings[]) => render(rows.filter(row => ![ ...row.values() ]
      .some(term => term.termType === 'BlankNode' || term.value === 'Anon')));
    expect(render(await answer(query, cottas(...byPredicate)))).toEqual(named(await answer(query, cottas(full))));
  });

  it('answers when one of the sources is not a COTTAS file', async() => {
    const query = QUERIES.path;
    const mixed = [
      { type: 'cottas', value: bySubject[0] },
      { type: 'serialized', value: nTriples, mediaType: 'application/n-triples', baseIRI: EX },
    ];
    expect(render(await answer(query, mixed))).toEqual(render(await answer(query, cottas(full))));
  });

  it('binds blocks into the union of both files of a subject split', async() => {
    await expect(physicalPlan(QUERIES.path, cottas(...bySubject))).resolves.toContain('bind-sources');
  });

  it('keeps the identity of a blank node passed through a join over several sources', async() => {
    const sources = cottas(...bySubject);
    const [ direct ] = await answer(`SELECT ?b WHERE { <${EX}p1> <${EX}knows> ?b . ?b <${EX}name> "Anon"@en }`, sources);
    const rows = await answer(`SELECT * WHERE {
      ?a <${EX}name> "Person 1" ; <${EX}knows> ?b .
      ?b <${EX}name> ?n ; <${EX}knows> ?c .
    }`, sources);
    const anonymous = rows.filter(row => row.get('b')!.termType === 'BlankNode');
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0].get('b')).toEqual(direct.get('b'));
    expect(anonymous[0].get('c')!.value).toBe(`${EX}p2`);
  });
});
