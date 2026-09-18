import type {
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IQuerySource,
} from '@comunica/types';
import { Algebra, isKnownOperation, AlgebraFactory } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import type { CottasDocument } from './CottasDocument';
import { CottasIterator } from './CottasIterator';

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
    this.selectorShape = {
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
  }

  public async getFilterFactor(_context: IActionContext): Promise<number> {
    return 1;
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return this.selectorShape;
  }

  public queryBindings(operation: Algebra.Operation, _context: IActionContext): BindingsStream {
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
