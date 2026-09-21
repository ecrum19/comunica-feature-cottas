/* eslint-disable import/no-nodejs-modules -- COTTAS and DuckDB are intentionally Node-only. */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/* eslint-enable import/no-nodejs-modules */
import type { ComunicaDataFactory } from '@comunica/types';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';
import type * as RDF from '@rdfjs/types';
import { Parser, Writer } from 'n3';

const COTTAS_COLUMNS = new Set([ 's', 'p', 'o', 'g' ]);
const REQUIRED_COLUMNS = [ 's', 'p', 'o' ];
const TERM_PREFIX = '<urn:comunica:cottas:subject> <urn:comunica:cottas:predicate> ';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
/**
 * Index orders a COTTAS source may provide, most significant component first.
 *
 * Each is a complete COTTAS file differing only in row order. A pattern is answered from the order
 * whose leading components are bound, so DuckDB can prune row groups on Parquet statistics instead
 * of scanning. The first entry is the primary file; the others are optional siblings.
 */
const INDEX_ORDERS: { name: string; components: ('s' | 'p' | 'o')[] }[] = [
  { name: 'spog', components: [ 's', 'p', 'o' ]},
  { name: 'posg', components: [ 'p', 'o', 's' ]},
  { name: 'ospg', components: [ 'o', 's', 'p' ]},
];
/**
 * Cardinality results kept per COTTAS document. Each entry is a short key and a small object, so
 * the bound costs a few megabytes at most; one WatDiv query produced ~2,200 distinct patterns.
 */
const CARDINALITY_CACHE_SIZE = 65_536;

/** Cardinality information returned by a COTTAS pattern scan. */
export interface ICottasCountResult {
  totalCount: number;
  hasExactCount: boolean;
}

/**
 * A bounded least-recently-used cache of pending cardinality lookups.
 *
 * A COTTAS document is a read-only file for its whole lifetime, so a pattern's cardinality cannot
 * change and may be reused. Pending promises are stored rather than resolved values, so the
 * concurrent duplicate probes a bind join produces collapse onto a single query.
 */
export class CardinalityCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  private readonly maxSize: number;

  public constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  public get(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Re-insert so that the most recently used key is evicted last.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  public set(key: string, value: Promise<T>): void {
    this.entries.set(key, value);
    // A failed lookup must not be remembered; the next caller should retry it. The identity check
    // matters because this entry may already have been evicted and replaced by the time it settles.
    value.catch(() => {
      if (this.entries.get(key) === value) {
        this.entries.delete(key);
      }
    });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxSize) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}

/** Graph-matching options shared by the COTTAS read operations. */
export interface ICottasGraphOptions {
  /**
   * Whether the default graph is the union of all graphs, as set by
   * Comunica's `KeysQueryOperation.unionDefaultGraph` context entry.
   */
  unionDefaultGraph?: boolean;
}

/** A bounded page of COTTAS bindings. */
export interface ICottasBindingsResult {
  bindings: RDF.Bindings[];
}

/** The narrow adapter contract between Comunica and the COTTAS runtime. */
export interface CottasDocument {
  readonly closed?: boolean;
  readonly hasGraphColumn: boolean;

  countPattern: (
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph?: RDF.Term,
    options?: ICottasGraphOptions,
  ) => Promise<ICottasCountResult>;

  searchBindings: (
    bindingsFactory: RDF.BindingsFactory,
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term | undefined,
    options: ICottasGraphOptions & { offset: number; limit: number },
  ) => Promise<ICottasBindingsResult>;

  close: () => Promise<void>;
}

interface ICottasSchemaRow {
  column_name: unknown;
  column_type: unknown;
}

interface ICottasRow {
  s: unknown;
  p: unknown;
  o: unknown;
  g?: unknown;
}

interface IPatternSql {
  whereClause: string;
  values: Record<string, string>;
  impossible: boolean;
}

/** A DuckDB-backed view over one local COTTAS file. */
class DuckDBCottasDocument implements CottasDocument {
  public closed = false;
  public readonly hasGraphColumn: boolean;

  private readonly cottasPath: string;
  private readonly indexPaths: Map<string, string>;
  private readonly connection: DuckDBConnection;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly instance: DuckDBInstance;
  private readonly termWriter = new Writer({ format: 'N-Triples' });
  private readonly cardinalities = new CardinalityCache<ICottasCountResult>(CARDINALITY_CACHE_SIZE);
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(
    cottasPath: string,
    instance: DuckDBInstance,
    connection: DuckDBConnection,
    dataFactory: ComunicaDataFactory,
    hasGraphColumn: boolean,
    indexPaths: Map<string, string>,
  ) {
    this.cottasPath = cottasPath;
    this.indexPaths = indexPaths;
    this.instance = instance;
    this.connection = connection;
    this.dataFactory = dataFactory;
    this.hasGraphColumn = hasGraphColumn;
  }

  public async countPattern(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term = this.dataFactory.defaultGraph(),
    options: ICottasGraphOptions = {},
  ): Promise<ICottasCountResult> {
    const key = this.cardinalityKey(subject, predicate, object, graph, options);
    const cached = this.closed ? undefined : this.cardinalities.get(key);
    if (cached) {
      return cached;
    }
    const pending = this.enqueue(async() => {
      const pattern = this.patternSql(subject, predicate, object, graph, options);
      if (pattern.impossible) {
        return { totalCount: 0, hasExactCount: true };
      }
      const reader = await this.connection.runAndReadAll(
        `SELECT count(*) AS count FROM read_parquet($path)${pattern.whereClause}`,
        { path: this.indexFor(subject, predicate, object), ...pattern.values },
      );
      const count = reader.getRowObjectsJS()[0]?.count;
      /* istanbul ignore if -- DuckDB COUNT returns BIGINT through getRowObjectsJS. */
      if (typeof count !== 'bigint') {
        throw new TypeError(`DuckDB returned an invalid COTTAS cardinality for '${this.cottasPath}'.`);
      }
      const totalCount = Number(count);
      /* istanbul ignore if -- files this large can not be represented by Comunica's numeric cardinality type. */
      if (!Number.isSafeInteger(totalCount)) {
        throw new TypeError(`The COTTAS cardinality for '${this.cottasPath}' exceeds JavaScript's safe integer range.`);
      }
      return { totalCount, hasExactCount: true };
    });
    if (!this.closed) {
      this.cardinalities.set(key, pending);
    }
    return pending;
  }

  public async searchBindings(
    bindingsFactory: RDF.BindingsFactory,
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term = this.dataFactory.defaultGraph(),
    options: ICottasGraphOptions & { offset: number; limit: number },
  ): Promise<ICottasBindingsResult> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0 ||
      !Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new TypeError('COTTAS page offset must be non-negative and its limit must be positive.');
    }
    return this.enqueue(async() => {
      const pattern = this.patternSql(subject, predicate, object, graph, options);
      if (pattern.impossible) {
        return { bindings: []};
      }
      const graphProjection = this.hasGraphColumn ? ', g' : '';
      const reader = await this.connection.runAndReadAll(
        `SELECT s, p, o${graphProjection} ` +
        `FROM read_parquet($path, file_row_number = true)${pattern.whereClause} ` +
        'ORDER BY file_row_number LIMIT $limit OFFSET $offset',
        {
          path: this.indexFor(subject, predicate, object),
          ...pattern.values,
          limit: options.limit,
          offset: options.offset,
        },
      );
      const rows = <ICottasRow[]> <unknown> reader.getRowObjectsJS();
      const quads = this.parseRows(rows);
      const bindings = quads.map((quad) => {
        const entries: [RDF.Variable, RDF.Term][] = [];
        this.addBinding(entries, subject, quad.subject);
        this.addBinding(entries, predicate, quad.predicate);
        this.addBinding(entries, object, quad.object);
        this.addBinding(entries, graph, quad.graph);
        return bindingsFactory.bindings(entries);
      });
      return { bindings };
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cardinalities.clear();
    await this.operationQueue;
    // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
    this.connection.closeSync();
    // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
    this.instance.closeSync();
  }

  private addBinding(
    entries: [RDF.Variable, RDF.Term][],
    patternTerm: RDF.Term,
    value: RDF.Term,
  ): void {
    if (patternTerm.termType === 'Variable' && !entries.some(([ variable ]) => variable.equals(patternTerm))) {
      entries.push([ patternTerm, value ]);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`The COTTAS document '${this.cottasPath}' is closed.`));
    }
    const queued = this.operationQueue.then(operation);
    this.operationQueue = queued.then(() => {
      // Continue the queue after success.
    }, () => {
      // Continue the queue after failure.
    });
    return queued;
  }

  private parseRows(rows: ICottasRow[]): RDF.BaseQuad[] {
    if (rows.length === 0) {
      return [];
    }
    const input = rows.map((row, index) => {
      for (const column of REQUIRED_COLUMNS) {
        if (typeof row[<keyof ICottasRow> column] !== 'string') {
          throw new TypeError(`COTTAS row ${index} has a non-string or null '${column}' value.`);
        }
      }
      /* istanbul ignore if -- schema validation guarantees VARCHAR and DuckDB maps its only nullable value to null. */
      if (this.hasGraphColumn && row.g !== null && typeof row.g !== 'string') {
        throw new Error(`COTTAS row ${index} has an invalid 'g' value.`);
      }
      const subject = <string> row.s;
      const predicate = <string> row.p;
      const object = <string> row.o;
      const graph = <string | null | undefined> row.g;
      return `${subject} ${predicate} ${object}${this.hasGraphColumn && graph !== null ? ` ${graph}` : ''} .`;
    }).join('\n');
    try {
      const quads = <RDF.BaseQuad[]> <unknown> new Parser({
        format: 'N-Quads',
        blankNodePrefix: '_:',
        factory: <any> this.dataFactory,
      }).parse(input);
      /* istanbul ignore if -- the N-Quads parser emits one quad for every validated line. */
      if (quads.length !== rows.length) {
        throw new Error(`expected ${rows.length} RDF statements but decoded ${quads.length}`);
      }
      return quads;
    } catch (error: unknown) {
      throw new Error(`Invalid RDF term encoding in COTTAS file '${this.cottasPath}': ${errorMessage(error)}`);
    }
  }

  /**
   * List every COTTAS encoding that denotes `term`.
   *
   * COTTAS cells hold N-Triples strings, and one RDF term has more than one legal encoding:
   * N3 escapes astral characters that files usually store raw, and RDF 1.1 makes a simple literal
   * the same term as an `xsd:string`-typed one. Comparing against a single serialization would
   * silently drop solutions from files that use another spelling.
   */
  private termEncodings(term: RDF.Term): string[] {
    const serialized = this.serializeTerm(term);
    const unescaped = unescapeUnicode(serialized);
    const encodings = unescaped === serialized ? [ serialized ] : [ serialized, unescaped ];
    if (term.termType === 'Literal' && !term.language && term.datatype.value === XSD_STRING) {
      return [ ...encodings, ...encodings.map(encoding => `${encoding}^^<${XSD_STRING}>`) ];
    }
    return encodings;
  }

  /** Build a condition matching any encoding of `term`, pushed down into DuckDB. */
  private termCondition(column: string, term: RDF.Term, addValue: (value: string) => string): string {
    const encodings = this.termEncodings(term);
    const language = term.termType === 'Literal' ? term.language : '';
    // The guard also rules out a base direction such as `@en--ltr`, where the tag is not the
    // final segment and slicing it off by length would cut into the direction instead.
    if (language && encodings.every(encoding => encoding.toLowerCase().endsWith(`@${language.toLowerCase()}`))) {
      // Language tags compare case-insensitively. The prefix pins the lexical form exactly,
      // so only the tag is left free to differ in case.
      const clauses = encodings.map((encoding) => {
        const lexical = addValue(encoding.slice(0, encoding.length - language.length));
        const folded = addValue(encoding.toLowerCase());
        return `(starts_with(${column}, ${lexical}) AND lower(${column}) = ${folded})`;
      });
      return `(${clauses.join(' OR ')})`;
    }
    return encodings.length === 1 ?
        `${column} = ${addValue(encodings[0])}` :
        `${column} IN (${encodings.map(addValue).join(', ')})`;
  }

  /**
   * Build a cache key identifying everything that can change a pattern's cardinality.
   *
   * Variables are numbered by first occurrence rather than by name, so `?x ?p ?x` and `?x ?p ?y`
   * stay distinct (the first adds an equality condition) while `?a ?b ?c` and `?x ?y ?z` share one
   * entry. Terms are spelled out directly rather than serialized: the key is built on every probe,
   * including the misses, so it must not repeat the work `patternSql` already does.
   */
  private cardinalityKey(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term,
    options: ICottasGraphOptions,
  ): string {
    const variables = new Map<string, number>();
    const part = (term: RDF.Term): string => {
      if (term.termType === 'Variable') {
        let index = variables.get(term.value);
        if (index === undefined) {
          index = variables.size;
          variables.set(term.value, index);
        }
        return `?${index}`;
      }
      if (term.termType === 'DefaultGraph') {
        return '*default*';
      }
      if (term.termType === 'Literal') {
        // Cheaper than serializing, and two literals are the same term exactly when their value,
        // language, and datatype agree. Cache misses are common, so this runs on the hot path.
        return `"${term.language}\u0001${term.datatype.value}\u0001${term.value}`;
      }
      return `${term.termType === 'BlankNode' ? '_:' : '<'}${term.value}`;
    };
    return [
      part(subject),
      part(predicate),
      part(object),
      part(graph),
      options.unionDefaultGraph ? 'union' : 'scoped',
    ].join('\n');
  }

  /**
   * Choose the index whose leading components are bound, longest prefix first.
   *
   * This is the selection rule used by nested-index triple stores such as rdf-stores.js: an order
   * only helps while its components are bound from the front, because that is the prefix Parquet
   * row-group statistics can prune on. A repeated variable is not a bound term.
   */
  private indexFor(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term): string {
    if (this.indexPaths.size === 0) {
      return this.cottasPath;
    }
    const bound = new Set<string>();
    for (const [ component, term ] of <[string, RDF.Term][]>[[ 's', subject ], [ 'p', predicate ], [ 'o', object ]]) {
      if (term.termType !== 'Variable') {
        bound.add(component);
      }
    }
    let best = this.cottasPath;
    let bestPrefix = -1;
    for (const order of INDEX_ORDERS) {
      const path = this.indexPaths.get(order.name);
      if (!path) {
        continue;
      }
      let prefix = 0;
      while (prefix < order.components.length && bound.has(order.components[prefix])) {
        prefix++;
      }
      if (prefix > bestPrefix) {
        bestPrefix = prefix;
        best = path;
      }
    }
    return best;
  }

  private patternSql(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term,
    options: ICottasGraphOptions,
  ): IPatternSql {
    const conditions: string[] = [];
    const values: Record<string, string> = {};
    const variables = new Map<string, string>();
    let impossible = false;
    let parameter = 0;

    const addValue = (value: string): string => {
      const parameterName = `term${parameter++}`;
      values[parameterName] = value;
      return `$${parameterName}`;
    };

    const addTerm = (column: string, term: RDF.Term, isGraph: boolean): void => {
      if (term.termType === 'Variable') {
        if (isGraph) {
          if (!this.hasGraphColumn) {
            impossible = true;
            return;
          }
          // Graph variables skip the default graph, unless it is the union of all graphs.
          if (!options.unionDefaultGraph) {
            conditions.push('g IS NOT NULL');
          }
        }
        const existingColumn = variables.get(term.value);
        if (existingColumn) {
          conditions.push(`${column} = ${existingColumn}`);
        } else {
          variables.set(term.value, column);
        }
        return;
      }
      if (isGraph && term.termType === 'DefaultGraph') {
        // Under union default graph semantics the default graph holds every graph's triples.
        if (this.hasGraphColumn && !options.unionDefaultGraph) {
          conditions.push('g IS NULL');
        }
        return;
      }
      if (isGraph && !this.hasGraphColumn) {
        impossible = true;
        return;
      }
      conditions.push(this.termCondition(column, term, addValue));
    };

    addTerm('s', subject, false);
    addTerm('p', predicate, false);
    addTerm('o', object, false);
    addTerm('g', graph, true);
    return {
      whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
      values,
      impossible,
    };
  }

  private serializeTerm(term: RDF.Term): string {
    /* istanbul ignore if -- patternSql handles these two non-value terms before serialization. */
    if (term.termType === 'Variable' || term.termType === 'DefaultGraph') {
      throw new Error(`RDF term '${term.termType}' cannot be serialized as a COTTAS value.`);
    }
    const line = this.termWriter.quadToString(
      this.dataFactory.namedNode('urn:comunica:cottas:subject'),
      this.dataFactory.namedNode('urn:comunica:cottas:predicate'),
      <RDF.Quad_Object> term,
    );
    /* istanbul ignore if -- N3's N-Triples writer guarantees this framing. */
    if (!line.startsWith(TERM_PREFIX) || !line.endsWith(' .\n')) {
      throw new Error(`Unable to serialize RDF term '${term.value}' for COTTAS.`);
    }
    return line.slice(TERM_PREFIX.length, -3);
  }
}

/** Open and validate one local COTTAS document. */
export async function openCottasDocument(
  inputPath: string,
  dataFactory: ComunicaDataFactory,
): Promise<CottasDocument> {
  const cottasPath = await validateLocalPath(inputPath);
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      'DESCRIBE SELECT * FROM read_parquet($path)',
      { path: cottasPath },
    );
    const schema = <ICottasSchemaRow[]> <unknown> reader.getRowObjectsJS();
    const columnNames = schema.map(row => String(row.column_name));
    if (REQUIRED_COLUMNS.some(name => !columnNames.includes(name)) ||
      columnNames.some(name => !COTTAS_COLUMNS.has(name))) {
      throw new Error(
        `expected exactly the columns 's', 'p', 'o', and optional 'g', but found ${columnNames.join(', ')}`,
      );
    }
    const invalidType = schema.find(row => row.column_type !== 'VARCHAR');
    if (invalidType) {
      throw new Error(`column '${String(invalidType.column_name)}' must be VARCHAR, not ${String(invalidType.column_type)}`);
    }
    // Sibling files holding the same data in another row order are optional; a source with only
    // the primary file keeps working exactly as before.
    const indexPaths = new Map<string, string>([[ INDEX_ORDERS[0].name, cottasPath ]]);
    for (const order of INDEX_ORDERS.slice(1)) {
      const siblingPath = cottasPath.replace(/(\.[^./]*)?$/u, match => `.${order.name}${match}`);
      if (await isReadableFile(siblingPath)) {
        await assertSameSchema(connection, siblingPath, columnNames);
        indexPaths.set(order.name, siblingPath);
      }
    }
    return new DuckDBCottasDocument(
      cottasPath,
      instance,
      connection,
      dataFactory,
      columnNames.includes('g'),
      indexPaths.size > 1 ? indexPaths : new Map(),
    );
  } catch (error: unknown) {
    // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
    connection.closeSync();
    // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
    instance.closeSync();
    throw new Error(`Unable to open COTTAS file '${cottasPath}': ${errorMessage(error)}`);
  }
}

async function isReadableFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** A sibling index must hold the same columns, or it is not the same dataset. */
async function assertSameSchema(
  connection: DuckDBConnection,
  siblingPath: string,
  columnNames: string[],
): Promise<void> {
  const reader = await connection.runAndReadAll(
    'DESCRIBE SELECT * FROM read_parquet($path)',
    { path: siblingPath },
  );
  const schema = <ICottasSchemaRow[]> <unknown> reader.getRowObjectsJS();
  const siblingColumns = schema.map(row => String(row.column_name));
  if (siblingColumns.join(',') !== columnNames.join(',')) {
    throw new Error(
      `index '${siblingPath}' has columns ${siblingColumns.join(', ')} but the primary file has ${
        columnNames.join(', ')}`,
    );
  }
}

async function validateLocalPath(inputPath: string): Promise<string> {
  if (!inputPath || /[*?[\]{}]/u.test(inputPath)) {
    throw new Error(`COTTAS source '${inputPath}' must be one local file path; globs are not supported.`);
  }
  if (!isAbsolute(inputPath) && /^[A-Za-z][A-Za-z\d+.-]*:/u.test(inputPath)) {
    throw new Error(`COTTAS source '${inputPath}' must be a local file path; URLs are not supported.`);
  }
  const cottasPath = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
  let fileStat;
  try {
    fileStat = await stat(cottasPath);
  } catch (error: unknown) {
    throw new Error(`Unable to access COTTAS file '${cottasPath}': ${errorMessage(error)}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`COTTAS source '${cottasPath}' must be a regular file.`);
  }
  return cottasPath;
}

/**
 * Decode the `\\uXXXX` and `\\UXXXXXXXX` escapes N3 writes for astral and control characters.
 *
 * Escapes are consumed left to right, so an escaped backslash is copied verbatim and never
 * mistaken for the start of a character escape.
 */
function unescapeUnicode(value: string): string {
  return value.replaceAll(
    /\\(?:U([\da-f]{8})|u([\da-f]{4})|(.))/gisu,
    (match, long: string | undefined, short: string | undefined) =>
      (long ?? short) === undefined ? match : String.fromCodePoint(Number.parseInt(long ?? short!, 16)),
  );
}

function errorMessage(error: unknown): string {
  /* istanbul ignore else -- Node.js and DuckDB reject with Error instances. */
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
