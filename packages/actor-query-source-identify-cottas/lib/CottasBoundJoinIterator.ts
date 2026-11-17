import type { BindingsStream, MetadataBindings, MetadataVariable } from '@comunica/types';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import type { BufferedIteratorOptions } from 'asynciterator';
import { BufferedIterator } from 'asynciterator';
import type {
  CottasBoundRow,
  CottasDocument,
  ICottasCursor,
  ICottasGraphOptions,
  ICottasJoinPattern,
} from './CottasDocument';

export interface ICottasBoundJoinIteratorOptions extends BufferedIteratorOptions, ICottasGraphOptions {
  /**
   * `join` extends every pushed binding with the solutions compatible with it; `filter` returns the
   * pattern's own solutions that are compatible with at least one pushed binding.
   */
  mode: 'join' | 'filter';
  /** The metadata of the pushed bindings, as passed along with them. */
  metadata: MetadataBindings;
  /** The variables of the pattern itself. */
  variables: MetadataVariable[];
  /**
   * Translate a pushed binding into the values it gives the pattern's variables, or undefined when
   * one of them can not occur in this document at all.
   */
  localize: (bindings: RDF.Bindings) => CottasBoundRow | undefined;
}

/**
 * Answers a basic graph pattern for a block of pushed bindings with one DuckDB query.
 *
 * Comunica's bind joins hand a source its left-hand bindings a block at a time. Querying once per
 * block rather than once per binding is what makes binding into COTTAS affordable: every query has
 * a fixed cost of several milliseconds, however few rows it returns.
 */
export class CottasBoundJoinIterator extends BufferedIterator<RDF.Bindings> {
  protected readonly cottasDocument: CottasDocument;
  protected readonly bindingsFactory: RDF.BindingsFactory;
  protected readonly patterns: ICottasJoinPattern[];
  protected readonly input: BindingsStream;
  protected readonly options: ICottasBoundJoinIteratorOptions;
  protected cursor: Promise<ICottasCursor<RDF.Bindings>> | undefined;

  public constructor(
    cottasDocument: CottasDocument,
    bindingsFactory: RDF.BindingsFactory,
    patterns: ICottasJoinPattern[],
    input: BindingsStream,
    options: ICottasBoundJoinIteratorOptions,
  ) {
    super(options);
    this.cottasDocument = cottasDocument;
    this.bindingsFactory = bindingsFactory;
    this.patterns = patterns;
    this.input = input;
    this.options = options;

    // No COUNT is run: a bind join derives its cardinality from its entries, so counting every
    // block would only add a query per block. The pushed bindings bound the estimate instead.
    const variables = [ ...options.variables ];
    if (options.mode === 'join') {
      for (const variable of options.metadata.variables) {
        if (!variables.some(known => known.variable.equals(variable.variable))) {
          variables.push(variable);
        }
      }
    }
    this.setProperty('metadata', {
      state: new MetadataValidationState(),
      cardinality: { type: 'estimate', value: options.metadata.cardinality.value },
      variables,
    });
  }

  public override _read(count: number, done: () => void): void {
    if (this.cottasDocument.closed) {
      this.close();
      return done();
    }
    this.cursor ??= this.open();
    this.cursor
      .then(async cursor => ({ cursor, bindings: await cursor.read(count) }))
      .then(async({ cursor, bindings }) => {
        for (const binding of bindings) {
          this._push(binding);
        }
        if (bindings.length < count) {
          await cursor.close();
          this.close();
        }
        done();
      })
      .catch((error: Error) => {
        this.destroy(error);
        return done();
      });
  }

  protected override _end(destroy?: boolean): void {
    this.cursor?.then(async cursor => cursor.close()).catch(() => {
      // The cursor already failed; its error has been reported through the stream.
    });
    super._end(destroy);
  }

  protected async open(): Promise<ICottasCursor<RDF.Bindings>> {
    const pushed: RDF.Bindings[] = [];
    const rows: CottasBoundRow[] = [];
    for (const bindings of await this.input.toArray()) {
      const row = this.options.localize(bindings);
      // A binding with a value that can not occur in this document joins with nothing here.
      if (row) {
        pushed.push(bindings);
        rows.push(row);
      }
    }
    const graphOptions = { unionDefaultGraph: this.options.unionDefaultGraph };
    if (this.options.mode === 'filter') {
      return this.cottasDocument.openFilterJoin(this.bindingsFactory, this.patterns, rows, graphOptions);
    }
    const cursor = await this.cottasDocument.openBoundJoin(this.bindingsFactory, this.patterns, rows, graphOptions);
    return {
      read: async(count: number) => (await cursor.read(count)).map(({ row, bindings }) => {
        const left = pushed[row];
        // The pushed binding keeps its own terms for the variables it binds. A solution may spell
        // the same term differently, such as a language tag in another case, and merging both would
        // then wrongly reject the solution as a conflict.
        return left.merge(bindings.filter((_value, variable) => !left.has(variable)))!;
      }),
      close: cursor.close,
    };
  }
}
