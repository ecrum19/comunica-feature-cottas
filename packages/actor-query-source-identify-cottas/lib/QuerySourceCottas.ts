import type {
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IQuerySource,
} from '@comunica/types';
import { Algebra, isKnownOperation, AlgebraFactory } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { ArrayIterator } from 'asynciterator';
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
  private readonly selectorShape: FragmentSelectorShape;
  private disposed = false;

  public constructor(
    cottasPath: string,
    cottasDocument: CottasDocument,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
    maxBufferSize: number,
  ) {
    this.cottasPath = cottasPath;
    this.referenceValue = cottasPath;
    this.cottasDocument = cottasDocument;
    this.dataFactory = dataFactory;
    this.bindingsFactory = bindingsFactory;
    this.maxBufferSize = maxBufferSize;
    this.selectorShape = {
      type: 'operation',
      operation: {
        operationType: 'pattern',
        pattern: AF.createPattern(
          this.dataFactory.variable('s'),
          this.dataFactory.variable('p'),
          this.dataFactory.variable('o'),
        ),
      },
      variablesOptional: [
        this.dataFactory.variable('s'),
        this.dataFactory.variable('p'),
        this.dataFactory.variable('o'),
      ],
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

    let it: AsyncIterator<RDF.Bindings>;
    if (operation.graph.termType === 'NamedNode') {
      it = new ArrayIterator<RDF.Bindings>([], { autoStart: false });
      it.setProperty('metadata', {
        state: new MetadataValidationState(),
        cardinality: { type: 'exact', value: 0 },
        variables: [],
      });
    } else {
      // Create an iterator over the COTTAS document
      it = new CottasIterator(
        this.cottasDocument,
        this.bindingsFactory,
        operation.subject,
        operation.predicate,
        operation.object,
        { autoStart: false, maxBufferSize: this.maxBufferSize },
      );
    }

    return it;
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
