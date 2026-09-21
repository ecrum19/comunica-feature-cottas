import { KeysQueryOperation } from '@comunica/context-entries';
import type {
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IQuerySource,
  MetadataVariable,
} from '@comunica/types';
import { Algebra, isKnownOperation, AlgebraFactory } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import type { CottasDocument, ICottasJoinPattern } from './CottasDocument';
import { CottasIterator } from './CottasIterator';
import { CottasJoinIterator } from './CottasJoinIterator';

const AF = new AlgebraFactory();

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
  private readonly selectorShape: FragmentSelectorShape;
  private disposed = false;

  public constructor(
    cottasPath: string,
    cottasDocument: CottasDocument,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
    maxBufferSize: number,
    pageSize: number,
  ) {
    this.cottasPath = cottasPath;
    this.referenceValue = cottasPath;
    this.cottasDocument = cottasDocument;
    this.dataFactory = dataFactory;
    this.bindingsFactory = bindingsFactory;
    this.maxBufferSize = maxBufferSize;
    this.pageSize = pageSize;
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

  public queryBindings(operation: Algebra.Operation, context: IActionContext): BindingsStream {
    const unionDefaultGraph = Boolean(context.get(KeysQueryOperation.unionDefaultGraph));
    if (isKnownOperation(operation, Algebra.Types.JOIN)) {
      const patterns = QuerySourceCottas.joinPatterns(operation);
      return new CottasJoinIterator(
        this.cottasDocument,
        this.bindingsFactory,
        patterns,
        QuerySourceCottas.joinVariables(patterns),
        { autoStart: false, maxBufferSize: this.maxBufferSize, unionDefaultGraph },
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
      },
    );
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
