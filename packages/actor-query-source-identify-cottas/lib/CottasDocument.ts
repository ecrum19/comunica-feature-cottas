/* eslint-disable import/no-nodejs-modules -- COTTAS and DuckDB are intentionally Node-only. */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/* eslint-enable import/no-nodejs-modules */
import type { ComunicaDataFactory } from '@comunica/types';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';
import type * as RDF from '@rdfjs/types';
import { CardinalityCache } from './CardinalityCache';
import { CottasTermCodec, errorMessage } from './CottasTerms';

const COTTAS_COLUMNS = new Set([ 's', 'p', 'o', 'g' ]);
const REQUIRED_COLUMNS = [ 's', 'p', 'o' ];
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

/** Graph-matching options shared by the COTTAS read operations. */
export interface ICottasGraphOptions {
  /**
   * Whether the default graph is the union of all graphs, as set by
   * Comunica's `KeysQueryOperation.unionDefaultGraph` context entry.
   */
  unionDefaultGraph?: boolean;
}

/** One triple pattern taking part in a pushed-down join. */
export interface ICottasJoinPattern {
  subject: RDF.Term;
  predicate: RDF.Term;
  object: RDF.Term;
  graph: RDF.Term;
}

/**
 * A live cursor over a pushed-down join.
 *
 * The join runs as one streaming DuckDB query, so consuming it page by page never re-executes it.
 */
export interface ICottasJoinCursor {
  read: (count: number) => Promise<RDF.Bindings[]>;
  close: () => Promise<void>;
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

  countJoin: (
    patterns: ICottasJoinPattern[],
    options?: ICottasGraphOptions,
  ) => Promise<ICottasCountResult>;

  openJoin: (
    bindingsFactory: RDF.BindingsFactory,
    patterns: ICottasJoinPattern[],
    options?: ICottasGraphOptions,
  ) => Promise<ICottasJoinCursor>;

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

/** Accumulates the pieces of a query while patterns are walked. */
interface ISqlContext {
  conditions: string[];
  values: Record<string, string>;
  /** Variable name to the column its first occurrence reads from. */
  columns: Map<string, string>;
  impossible: boolean;
  addValue: (value: string) => string;
}

interface IJoinSql {
  sql: string;
  values: Record<string, string>;
  variables: string[];
  impossible: boolean;
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
  private readonly terms: CottasTermCodec;
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
    this.terms = new CottasTermCodec(dataFactory, cottasPath);
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

  public async countJoin(
    patterns: ICottasJoinPattern[],
    options: ICottasGraphOptions = {},
  ): Promise<ICottasCountResult> {
    return this.enqueue(async() => {
      const join = this.joinSql(patterns, options);
      if (join.impossible) {
        return { totalCount: 0, hasExactCount: true };
      }
      const reader = await this.connection.runAndReadAll(
        `SELECT count(*) AS count FROM (${join.sql})`,
        join.values,
      );
      const count = reader.getRowObjectsJS()[0]?.count;
      /* istanbul ignore if -- DuckDB COUNT returns BIGINT through getRowObjectsJS. */
      if (typeof count !== 'bigint') {
        throw new TypeError(`DuckDB returned an invalid COTTAS cardinality for '${this.cottasPath}'.`);
      }
      return { totalCount: Number(count), hasExactCount: true };
    });
  }

  /**
   * Run a basic graph pattern as one streaming DuckDB query.
   *
   * The cursor gets its own connection: a streaming result holds its connection for as long as it
   * is being read, so sharing one would serialise concurrent joins behind each other.
   */
  public async openJoin(
    bindingsFactory: RDF.BindingsFactory,
    patterns: ICottasJoinPattern[],
    options: ICottasGraphOptions = {},
  ): Promise<ICottasJoinCursor> {
    const join = this.joinSql(patterns, options);
    if (join.impossible) {
      return { read: async() => [], close: async() => {
        // Nothing was opened.
      } };
    }
    const variables = join.variables.map(variable => this.dataFactory.variable(variable));
    const connection = await this.enqueue(async() => this.instance.connect());
    // Chunks are fetched and discarded one at a time: materialising the whole result to slice a
    // page out of it would be quadratic in the number of pages.
    const result = await connection.stream(join.sql, join.values);
    let pending: string[][] = [];
    let exhausted = false;
    let closed = false;

    const release = async(): Promise<void> => {
      if (!closed) {
        closed = true;
        pending = [];
        // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
        connection.closeSync();
      }
    };

    return {
      read: async(count: number): Promise<RDF.Bindings[]> => {
        if (closed) {
          return [];
        }
        while (pending.length < count && !exhausted) {
          const chunk = await result.fetchChunk();
          if (chunk === null || chunk.rowCount === 0) {
            exhausted = true;
            break;
          }
          pending.push(...<string[][]> <unknown> chunk.getRows());
        }
        const page = pending.splice(0, count);
        if (page.length === 0) {
          return [];
        }
        if (variables.length === 0) {
          return page.map(() => bindingsFactory.bindings([]));
        }
        const terms = this.terms.parseTerms(page.flat());
        return page.map(row => bindingsFactory.bindings(variables
          .map((variable, index): [RDF.Variable, RDF.Term] => [ variable, terms.get(row[index])! ])));
      },
      close: release,
    };
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
    return this.terms.parseStatements(input, rows.length);
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

  /**
   * Add one pattern's conditions to a query being built.
   *
   * Shared by the single-pattern and join paths so term encoding and graph semantics cannot drift
   * apart between them. `alias` is empty for a single pattern, keeping its SQL on bare column names.
   */
  private addPatternConditions(
    context: ISqlContext,
    alias: string,
    pattern: ICottasJoinPattern,
    options: ICottasGraphOptions,
  ): void {
    const positions: [string, RDF.Term, boolean][] = [
      [ 's', pattern.subject, false ],
      [ 'p', pattern.predicate, false ],
      [ 'o', pattern.object, false ],
      [ 'g', pattern.graph, true ],
    ];
    for (const [ column, term, isGraph ] of positions) {
      const qualified = alias === '' ? column : `${alias}.${column}`;
      if (term.termType === 'Variable') {
        if (isGraph) {
          if (!this.hasGraphColumn) {
            context.impossible = true;
            continue;
          }
          // Graph variables skip the default graph, unless it is the union of all graphs.
          if (!options.unionDefaultGraph) {
            context.conditions.push(`${qualified} IS NOT NULL`);
          }
        }
        // A variable's first occurrence fixes the column it reads from; any later occurrence, in
        // this pattern or another, becomes an equality against it. That is SPARQL's join condition,
        // which is term equality, and terms are stored as canonical N-Triples strings.
        const first = context.columns.get(term.value);
        if (first) {
          context.conditions.push(`${qualified} = ${first}`);
        } else {
          context.columns.set(term.value, qualified);
        }
        continue;
      }
      if (isGraph && term.termType === 'DefaultGraph') {
        // Under union default graph semantics the default graph holds every graph's triples.
        if (this.hasGraphColumn && !options.unionDefaultGraph) {
          context.conditions.push(`${qualified} IS NULL`);
        }
        continue;
      }
      if (isGraph && !this.hasGraphColumn) {
        context.impossible = true;
        continue;
      }
      context.conditions.push(this.terms.condition(qualified, term, context.addValue));
    }
  }

  /** Start a query builder in which every RDF value becomes a bound parameter. */
  private sqlContext(): ISqlContext {
    const values: Record<string, string> = {};
    let parameter = 0;
    return {
      conditions: [],
      values,
      columns: new Map(),
      impossible: false,
      addValue: (value: string): string => {
        const parameterName = `term${parameter++}`;
        values[parameterName] = value;
        return `$${parameterName}`;
      },
    };
  }

  /**
   * Compile a basic graph pattern into one SQL query.
   *
   * Patterns are comma-joined rather than written as explicit JOINs, leaving DuckDB free to choose
   * its own join order. Every alias and column name is generated here; all RDF values reach the
   * query as bound parameters.
   */
  private joinSql(patterns: ICottasJoinPattern[], options: ICottasGraphOptions): IJoinSql {
    const context = this.sqlContext();
    const froms = patterns.map((pattern, index) => `read_parquet(${
      context.addValue(this.indexFor(pattern.subject, pattern.predicate, pattern.object))}) AS t${index}`);
    for (const [ index, pattern ] of patterns.entries()) {
      this.addPatternConditions(context, `t${index}`, pattern, options);
    }

    const variables = [ ...context.columns.keys() ];
    // A pattern of nothing but constants still yields one row per match, hence the literal.
    const select = variables.length === 0 ?
      '1 AS present' :
      variables.map((variable, index) => `${context.columns.get(variable)!} AS c${index}`).join(', ');
    const where = context.conditions.length > 0 ? ` WHERE ${context.conditions.join(' AND ')}` : '';
    return {
      sql: `SELECT ${select} FROM ${froms.join(', ')}${where}`,
      values: context.values,
      variables,
      impossible: context.impossible,
    };
  }

  private patternSql(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term,
    options: ICottasGraphOptions,
  ): IPatternSql {
    const context = this.sqlContext();
    this.addPatternConditions(context, '', { subject, predicate, object, graph }, options);
    return {
      whereClause: context.conditions.length > 0 ? ` WHERE ${context.conditions.join(' AND ')}` : '',
      values: context.values,
      impossible: context.impossible,
    };
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
