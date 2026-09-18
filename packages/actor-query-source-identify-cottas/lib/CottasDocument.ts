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
  private readonly connection: DuckDBConnection;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly instance: DuckDBInstance;
  private readonly termWriter = new Writer({ format: 'N-Triples' });
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(
    cottasPath: string,
    instance: DuckDBInstance,
    connection: DuckDBConnection,
    dataFactory: ComunicaDataFactory,
    hasGraphColumn: boolean,
  ) {
    this.cottasPath = cottasPath;
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
    return this.enqueue(async() => {
      const pattern = this.patternSql(subject, predicate, object, graph, options);
      if (pattern.impossible) {
        return { totalCount: 0, hasExactCount: true };
      }
      const reader = await this.connection.runAndReadAll(
        `SELECT count(*) AS count FROM read_parquet($path)${pattern.whereClause}`,
        { path: this.cottasPath, ...pattern.values },
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
          path: this.cottasPath,
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
    return new DuckDBCottasDocument(
      cottasPath,
      instance,
      connection,
      dataFactory,
      columnNames.includes('g'),
    );
  } catch (error: unknown) {
    // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
    connection.closeSync();
    // eslint-disable-next-line no-sync -- DuckDB exposes synchronous close methods only.
    instance.closeSync();
    throw new Error(`Unable to open COTTAS file '${cottasPath}': ${errorMessage(error)}`);
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
