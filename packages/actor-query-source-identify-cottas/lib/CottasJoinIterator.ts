import type { MetadataVariable } from '@comunica/types';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import type { BufferedIteratorOptions } from 'asynciterator';
import { BufferedIterator } from 'asynciterator';
import type { CottasDocument, ICottasGraphOptions, ICottasJoinCursor, ICottasJoinPattern } from './CottasDocument';

/**
 * Iterates over a basic graph pattern that was pushed down into COTTAS as a single join.
 *
 * Unlike {@link CottasIterator}, which pages with LIMIT/OFFSET, this holds one streaming DuckDB
 * result for its lifetime: paging a join by offset would re-run the whole join for every page.
 */
export class CottasJoinIterator extends BufferedIterator<RDF.Bindings> {
  protected readonly cottasDocument: CottasDocument;
  protected readonly bindingsFactory: RDF.BindingsFactory;
  protected readonly patterns: ICottasJoinPattern[];
  protected readonly options: ICottasGraphOptions;
  protected cursor: Promise<ICottasJoinCursor> | undefined;

  public constructor(
    cottasDocument: CottasDocument,
    bindingsFactory: RDF.BindingsFactory,
    patterns: ICottasJoinPattern[],
    variables: MetadataVariable[],
    options: BufferedIteratorOptions & ICottasGraphOptions,
  ) {
    super(options);
    this.cottasDocument = cottasDocument;
    this.bindingsFactory = bindingsFactory;
    this.patterns = patterns;
    this.options = { unionDefaultGraph: options.unionDefaultGraph };

    this.cottasDocument.countJoin(patterns, this.options)
      .then(({ totalCount, hasExactCount }) => {
        this.setProperty('metadata', {
          state: new MetadataValidationState(),
          cardinality: { type: hasExactCount ? 'exact' : 'estimate', value: totalCount },
          variables,
        });
      })
      .catch(error => this.destroy(error));
  }

  public override _read(count: number, done: () => void): void {
    if ((<any> this.cottasDocument).closed) {
      this.close();
      return done();
    }
    this.cursor ??= this.cottasDocument.openJoin(this.bindingsFactory, this.patterns, this.options);
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
    // Release the streaming result and its connection as soon as the consumer stops reading.
    this.cursor?.then(async cursor => cursor.close()).catch(() => {
      // The cursor already failed; its error has been reported through the stream.
    });
    super._end(destroy);
  }
}
