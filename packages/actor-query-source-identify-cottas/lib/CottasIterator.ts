import type { MetadataVariable } from '@comunica/types';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import type { BufferedIteratorOptions } from 'asynciterator';
import { BufferedIterator } from 'asynciterator';
import type { CottasDocument, ICottasBindingsResult } from './CottasDocument';

/**
 * Iterates over a COTTAS document in chunks for a triple pattern query.
 */
export class CottasIterator extends BufferedIterator<RDF.Bindings> {
  protected readonly cottasDocument: CottasDocument;
  protected readonly bindingsFactory: RDF.BindingsFactory;
  protected readonly subject: RDF.Term;
  protected readonly predicate: RDF.Term;
  protected readonly object: RDF.Term;
  protected readonly graph: RDF.Term;
  protected readonly pageSize: number;

  protected position: number;
  protected nextPageSize: number;

  public constructor(
    cottasDocument: CottasDocument,
    bindingsFactory: RDF.BindingsFactory,
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    options: BufferedIteratorOptions & {
      graph?: RDF.Term;
      /**
       * The number of bindings to request from the COTTAS document in a single call.
       * Larger pages cost fewer scans of the file, at the cost of reading further ahead.
       */
      pageSize?: number;
    },
  ) {
    super(options);
    this.pageSize = options.pageSize ?? 0;
    this.cottasDocument = cottasDocument;
    this.bindingsFactory = bindingsFactory;
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
    this.graph = options.graph ?? {
      termType: 'DefaultGraph',
      value: '',
      equals: other => other?.termType === 'DefaultGraph',
    };
    this.position = 0;
    this.nextPageSize = 0;

    const variables: MetadataVariable[] = [];
    if (subject.termType === 'Variable') {
      variables.push({ variable: subject, canBeUndef: false });
    }
    if (predicate.termType === 'Variable' && !variables.some(variable => variable.variable.equals(predicate))) {
      variables.push({ variable: predicate, canBeUndef: false });
    }
    if (object.termType === 'Variable' && !variables.some(variable => variable.variable.equals(object))) {
      variables.push({ variable: object, canBeUndef: false });
    }
    if (this.graph.termType === 'Variable' && !variables.some(variable => variable.variable.equals(this.graph))) {
      variables.push({ variable: this.graph, canBeUndef: false });
    }

    this.cottasDocument.countPattern(subject, predicate, object, this.graph)
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
    // Read a growing page instead of only the bindings that are needed right now.
    // Every page is a separate scan of the COTTAS file that seeks to its offset, and that seek is
    // linear in the offset, so buffer-sized pages make a full traversal quadratic.
    const limit = Math.max(count, Math.min(this.pageSize, this.nextPageSize));
    this.nextPageSize = limit * 2;
    this.cottasDocument.searchBindings(
      this.bindingsFactory,
      this.subject,
      this.predicate,
      this.object,
      this.graph,
      { offset: this.position, limit },
    ).then((searchResult: ICottasBindingsResult) => {
      for (const b of searchResult.bindings) {
        this._push(b);
      }
      if (searchResult.bindings.length < limit) {
        this.close();
      }
      this.position += searchResult.bindings.length;
      done();
    })
      .catch((error: Error) => {
        this.destroy(error);
        return done();
      });
  }
}
