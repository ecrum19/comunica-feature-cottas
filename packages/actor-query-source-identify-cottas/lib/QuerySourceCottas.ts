import { KeysQueryOperation, KeysQuerySourceIdentify } from '@comunica/context-entries';
import type {
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IQueryBindingsOptions,
  IQuerySource,
  MetadataVariable,
} from '@comunica/types';
import { Algebra, isKnownOperation, AlgebraFactory } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { CottasBoundJoinIterator } from './CottasBoundJoinIterator';
import type { CottasBoundRow, CottasDocument, ICottasJoinPattern } from './CottasDocument';
import { CottasIterator } from './CottasIterator';
import { CottasJoinIterator } from './CottasJoinIterator';

const AF = new AlgebraFactory();
/** The IRI prefix Comunica's skolemization gives the blank nodes of each source. */
const SKOLEM_PREFIX = 'urn:comunica_skolem:source_';

/**
 * A query source over a COTTAS file.
 */
export class QuerySourceCottas implements IQuerySource {
  public referenceValue: string;
  protected readonly cottasPath: string;
  protected readonly cottasDocument: CottasDocument;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly bindingsFactory: BindingsFactory;
  private readonly maxBufferSize: number;
  private readonly pageSize: number;
  private readonly requestTime: number | undefined;
  private readonly selectorShape: FragmentSelectorShape;
  private disposed = false;

  public constructor(
    cottasPath: string,
    cottasDocument: CottasDocument,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
    maxBufferSize: number,
    pageSize: number,
    requestTime?: number,
  ) {
    this.cottasPath = cottasPath;
    this.referenceValue = cottasPath;
    this.cottasDocument = cottasDocument;
    this.dataFactory = dataFactory;
    this.bindingsFactory = bindingsFactory;
    this.maxBufferSize = maxBufferSize;
    this.pageSize = pageSize;
    this.requestTime = requestTime;
    const subject = this.dataFactory.variable('s');
    const predicate = this.dataFactory.variable('p');
    const object = this.dataFactory.variable('o');
    const graph = this.dataFactory.variable('g');
    const patternShape: FragmentSelectorShape = {
      type: 'operation',
      operation: {
        operationType: 'pattern',
        pattern: AF.createPattern(
          subject,
          predicate,
          object,
          this.cottasDocument.hasGraphColumn ? graph : undefined,
        ),
      },
      variablesOptional: this.cottasDocument.hasGraphColumn ?
          [ subject, predicate, object, graph ] :
          [ subject, predicate, object ],
      // Bind joins may push a block of bindings along with an operation; see queryBindings.
      joinBindings: true,
      filterBindings: true,
    };
    // A join of patterns is accepted as well, so that a basic graph pattern reaches the source
    // whole and can be answered by one SQL query instead of a lookup per binding.
    this.selectorShape = {
      type: 'disjunction',
      children: [
        patternShape,
        {
          type: 'operation',
          operation: { operationType: 'type', type: Algebra.Types.JOIN },
          children: [ patternShape ],
          joinBindings: true,
          filterBindings: true,
        },
      ],
    };
  }

  /**
   * The patterns a join is made of, in the left-to-right order they were written.
   *
   * The planner may nest joins rather than hand over one flat list, so a join among the children is
   * descended into: joining is associative, which makes a join of joins of patterns the same join
   * over all of those patterns, answerable by one SQL query.
   */
  private static joinPatterns(operation: Algebra.Operation): ICottasJoinPattern[] {
    if (isKnownOperation(operation, Algebra.Types.JOIN)) {
      return operation.input.flatMap(input => QuerySourceCottas.joinPatterns(input));
    }
    if (!isKnownOperation(operation, Algebra.Types.PATTERN)) {
      throw new Error(`Attempted to pass a join over '${operation.type}' to QuerySourceCottas`);
    }
    return [{
      subject: operation.subject,
      predicate: operation.predicate,
      object: operation.object,
      graph: operation.graph,
    }];
  }

  /** The join's variables, in the first-occurrence order the compiled SQL projects them. */
  private static joinVariables(patterns: ICottasJoinPattern[]): MetadataVariable[] {
    const variables: MetadataVariable[] = [];
    for (const pattern of patterns) {
      for (const term of [ pattern.subject, pattern.predicate, pattern.object, pattern.graph ]) {
        if (term.termType === 'Variable' && !variables.some(known => known.variable.equals(term))) {
          variables.push({ variable: term, canBeUndef: false });
        }
      }
    }
    return variables;
  }

  public async getFilterFactor(_context: IActionContext): Promise<number> {
    return 1;
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return this.selectorShape;
  }

  public queryBindings(
    operation: Algebra.Operation,
    context: IActionContext,
    options?: IQueryBindingsOptions,
  ): BindingsStream {
    const unionDefaultGraph = Boolean(context.get(KeysQueryOperation.unionDefaultGraph));
    const pushed = options?.joinBindings ?? options?.filterBindings;
    if (pushed) {
      if (!isKnownOperation(operation, Algebra.Types.JOIN) && !isKnownOperation(operation, Algebra.Types.PATTERN)) {
        throw new Error(`Attempted to pass non-pattern operation '${operation.type}' to QuerySourceCottas`);
      }
      const patterns = QuerySourceCottas.joinPatterns(operation);
      const variables = QuerySourceCottas.joinVariables(patterns);
      const sourceId = context.get(KeysQuerySourceIdentify.sourceIds)?.get(this.referenceValue);
      return new CottasBoundJoinIterator(this.cottasDocument, this.bindingsFactory, patterns, pushed.bindings, {
        autoStart: false,
        maxBufferSize: this.maxBufferSize,
        unionDefaultGraph,
        mode: options!.joinBindings ? 'join' : 'filter',
        metadata: pushed.metadata,
        variables,
        localize: bindings => this.localize(bindings, variables, sourceId),
      });
    }
    if (isKnownOperation(operation, Algebra.Types.JOIN)) {
      const patterns = QuerySourceCottas.joinPatterns(operation);
      return new CottasJoinIterator(
        this.cottasDocument,
        this.bindingsFactory,
        patterns,
        QuerySourceCottas.joinVariables(patterns),
        { autoStart: false, maxBufferSize: this.maxBufferSize, unionDefaultGraph, requestTime: this.requestTime },
      );
    }
    if (!isKnownOperation(operation, Algebra.Types.PATTERN)) {
      throw new Error(`Attempted to pass non-pattern operation '${operation.type}' to QuerySourceCottas`);
    }

    return new CottasIterator(
      this.cottasDocument,
      this.bindingsFactory,
      operation.subject,
      operation.predicate,
      operation.object,
      {
        autoStart: false,
        maxBufferSize: this.maxBufferSize,
        pageSize: this.pageSize,
        graph: operation.graph,
        unionDefaultGraph,
        requestTime: this.requestTime,
      },
    );
  }

  /**
   * The values a pushed binding gives the join's variables, as terms of this document.
   *
   * Comunica hands every source's blank nodes around skolemized, scoped to the source they came
   * from. One of this document's own blank nodes is turned back into the blank node stored in the
   * file. A blank node from any other source can never occur here, so a binding holding one for a
   * variable of the join can not match, which is signalled by returning undefined.
   */
  private localize(
    bindings: RDF.Bindings,
    variables: MetadataVariable[],
    sourceId: string | undefined,
  ): CottasBoundRow | undefined {
    const row: CottasBoundRow = new Map();
    for (const { variable } of variables) {
      const term = bindings.get(variable);
      if (term) {
        const local = this.localTerm(term, sourceId);
        if (!local) {
          return undefined;
        }
        row.set(variable.value, local);
      }
    }
    return row;
  }

  private localTerm(term: RDF.Term, sourceId: string | undefined): RDF.Term | undefined {
    if (term.termType === 'Quad') {
      const parts = [ term.subject, term.predicate, term.object, term.graph ]
        .map(part => this.localTerm(part, sourceId));
      return parts.every(Boolean) ?
        this.dataFactory.quad(<any> parts[0], <any> parts[1], <any> parts[2], <any> parts[3]) :
        undefined;
    }
    const skolemized: RDF.Term = term.termType === 'BlankNode' && 'skolemized' in term ?
      <RDF.Term> term.skolemized :
      term;
    if (skolemized.termType === 'NamedNode' && skolemized.value.startsWith(SKOLEM_PREFIX)) {
      const separator = skolemized.value.indexOf(':', SKOLEM_PREFIX.length);
      return skolemized.value.slice(SKOLEM_PREFIX.length, separator) === sourceId ?
        this.dataFactory.blankNode(skolemized.value.slice(separator + 1)) :
        undefined;
    }
    return skolemized;
  }

  public queryQuads(
    _operation: Algebra.Operation,
    _context: IActionContext,
  ): AsyncIterator<RDF.Quad> {
    throw new Error('queryQuads is not implemented in QuerySourceCottas');
  }

  public queryBoolean(
    _operation: Algebra.Ask,
    _context: IActionContext,
  ): Promise<boolean> {
    throw new Error('queryBoolean is not implemented in QuerySourceCottas');
  }

  public queryVoid(
    _operation: Algebra.Operation,
    _context: IActionContext,
  ): Promise<void> {
    throw new Error('queryVoid is not implemented in QuerySourceCottas');
  }

  public toString(): string {
    return `QuerySourceCottas(${this.cottasPath})`;
  }

  public async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      await this.cottasDocument.close();
    }
  }
}
