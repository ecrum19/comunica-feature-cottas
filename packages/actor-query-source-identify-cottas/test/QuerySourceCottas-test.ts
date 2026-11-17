import { KeysQueryOperation, KeysQuerySourceIdentify } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import { Algebra, AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { BlankNodeScoped } from '@comunica/utils-data-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { doesShapeAcceptOperation } from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import type { CottasDocument } from '../lib/CottasDocument';
import { QuerySourceCottas } from '../lib/QuerySourceCottas';
import { MockedCottasDocument } from './MockedCottasDocument';
import '@comunica/utils-jest';

const DF = new DataFactory();
const BF = new BindingsFactory(DF);
const AF = new AlgebraFactory();

describe('QuerySourceCottas', () => {
  let cottasDocument: CottasDocument;
  let ctx: IActionContext;
  let source: QuerySourceCottas;

  beforeEach(() => {
    cottasDocument = new MockedCottasDocument([
      DF.quad(DF.namedNode('s1'), DF.namedNode('p'), DF.namedNode('o1')),
      DF.quad(DF.namedNode('s2'), DF.namedNode('p'), DF.namedNode('o2')),
      DF.quad(DF.namedNode('s3'), DF.namedNode('px'), DF.namedNode('o3')),
    ]);
    ctx = new ActionContext({});
    source = new QuerySourceCottas(
      'path',
      cottasDocument,
      DF,
      BF,
      128,
      8192,
    );
  });

  describe('getSelectorShape', () => {
    const patternShape = {
      type: 'operation',
      operation: {
        operationType: 'pattern',
        pattern: AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o')),
      },
      variablesOptional: [
        DF.variable('s'),
        DF.variable('p'),
        DF.variable('o'),
      ],
      joinBindings: true,
      filterBindings: true,
    };

    it('should accept a pattern or a join of patterns', async() => {
      await expect(source.getSelectorShape()).resolves.toEqual({
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
      });
    });

    it('should let Comunica push a basic graph pattern into the source', async() => {
      const shape = await source.getSelectorShape();
      const join = AF.createJoin([
        AF.createPattern(DF.variable('a'), DF.namedNode('p'), DF.variable('b')),
        AF.createPattern(DF.variable('b'), DF.namedNode('p'), DF.variable('c')),
      ]);
      expect(doesShapeAcceptOperation(shape, join)).toBe(true);
      expect(doesShapeAcceptOperation(shape, AF.createPattern(
        DF.variable('a'),
        DF.variable('b'),
        DF.variable('c'),
      ))).toBe(true);
      // A union is not something the source can answer.
      expect(doesShapeAcceptOperation(shape, AF.createUnion([
        AF.createPattern(DF.variable('a'), DF.namedNode('p'), DF.variable('b')),
        AF.createPattern(DF.variable('b'), DF.namedNode('p'), DF.variable('c')),
      ]))).toBe(false);
    });
  });

  describe('join push-down', () => {
    it('should answer a basic graph pattern as one join', async() => {
      const join = AF.createJoin([
        AF.createPattern(DF.variable('s'), DF.namedNode('p'), DF.variable('o')),
        AF.createPattern(DF.variable('s'), DF.namedNode('px'), DF.variable('o2')),
      ]);
      await expect(source.queryBindings(join, ctx)).toEqualBindingsStream([]);
    });

    it('should bind variables shared between patterns', async() => {
      const document = new MockedCottasDocument([
        DF.quad(DF.namedNode('a'), DF.namedNode('knows'), DF.namedNode('b')),
        DF.quad(DF.namedNode('b'), DF.namedNode('knows'), DF.namedNode('c')),
      ]);
      const joined = new QuerySourceCottas('j', document, DF, BF, 128, 8192);
      const data = joined.queryBindings(AF.createJoin([
        AF.createPattern(DF.variable('x'), DF.namedNode('knows'), DF.variable('y')),
        AF.createPattern(DF.variable('y'), DF.namedNode('knows'), DF.variable('z')),
      ]), ctx);
      await expect(data).toEqualBindingsStream([
        BF.fromRecord({ x: DF.namedNode('a'), y: DF.namedNode('b'), z: DF.namedNode('c') }),
      ]);
      await expect(new Promise(resolve => data.getProperty('metadata', resolve))).resolves.toMatchObject({
        cardinality: { type: 'exact', value: 1 },
        variables: [
          { variable: DF.variable('x'), canBeUndef: false },
          { variable: DF.variable('y'), canBeUndef: false },
          { variable: DF.variable('z'), canBeUndef: false },
        ],
      });
    });

    it('should flatten a join the planner nested inside another join', async() => {
      const document = new MockedCottasDocument([
        DF.quad(DF.namedNode('a'), DF.namedNode('knows'), DF.namedNode('b')),
        DF.quad(DF.namedNode('b'), DF.namedNode('knows'), DF.namedNode('c')),
        DF.quad(DF.namedNode('c'), DF.namedNode('knows'), DF.namedNode('d')),
      ]);
      const joined = new QuerySourceCottas('j', document, DF, BF, 128, 8192);
      const data = joined.queryBindings(AF.createJoin([
        AF.createJoin([
          AF.createPattern(DF.variable('x'), DF.namedNode('knows'), DF.variable('y')),
          AF.createPattern(DF.variable('y'), DF.namedNode('knows'), DF.variable('z')),
        ]),
        AF.createPattern(DF.variable('z'), DF.namedNode('knows'), DF.variable('w')),
      ]), ctx);
      await expect(data).toEqualBindingsStream([
        BF.fromRecord({
          x: DF.namedNode('a'),
          y: DF.namedNode('b'),
          z: DF.namedNode('c'),
          w: DF.namedNode('d'),
        }),
      ]);
    });

    it('should reject a join over something that is not a pattern', () => {
      const join = AF.createJoin([
        AF.createPattern(DF.variable('s'), DF.namedNode('p'), DF.variable('o')),
        AF.createUnion([]),
      ]);
      expect(() => source.queryBindings(join, ctx))
        .toThrow(`Attempted to pass a join over 'union' to QuerySourceCottas`);
    });
  });

  describe('pushed bindings', () => {
    const knows = DF.namedNode('knows');
    const pattern = (subject: RDF.Term, object: RDF.Term) => AF.createPattern(subject, knows, object);
    const leftMetadata = (...names: string[]) => ({
      state: new MetadataValidationState(),
      cardinality: { type: <const> 'exact', value: 10 },
      variables: names.map(name => ({ variable: DF.variable(name), canBeUndef: name === 'maybe' })),
    });
    const push = (records: Record<string, RDF.Term>[], ...names: string[]) => ({
      bindings: new ArrayIterator(records.map(record => BF.fromRecord(record)), { autoStart: false }),
      metadata: leftMetadata(...names),
    });
    let document: MockedCottasDocument;
    let joined: QuerySourceCottas;

    beforeEach(() => {
      document = new MockedCottasDocument([
        DF.quad(DF.namedNode('a'), knows, DF.namedNode('b')),
        DF.quad(DF.namedNode('b'), knows, DF.namedNode('c')),
        DF.quad(DF.blankNode('n'), knows, DF.namedNode('a')),
      ]);
      joined = new QuerySourceCottas('j', document, DF, BF, 128, 8192);
    });

    it('should accept join and filter bindings for patterns and joins of patterns', async() => {
      const shape = await joined.getSelectorShape();
      const single = pattern(DF.variable('x'), DF.variable('y'));
      const both = AF.createJoin([ single, pattern(DF.variable('y'), DF.variable('z')) ]);
      for (const operation of [ single, both ]) {
        expect(doesShapeAcceptOperation(shape, operation, { joinBindings: true })).toBe(true);
        expect(doesShapeAcceptOperation(shape, operation, { filterBindings: true })).toBe(true);
      }
    });

    it('should extend each pushed binding, keeping variables the pattern does not mention', async() => {
      const data = joined.queryBindings(pattern(DF.variable('x'), DF.variable('y')), ctx, {
        joinBindings: push([
          { x: DF.namedNode('a'), other: DF.literal('kept') },
          { x: DF.namedNode('b') },
          { x: DF.namedNode('nobody') },
        ], 'x', 'other'),
      });
      await expect(data).toEqualBindingsStream([
        BF.fromRecord({ x: DF.namedNode('a'), other: DF.literal('kept'), y: DF.namedNode('b') }),
        BF.fromRecord({ x: DF.namedNode('b'), y: DF.namedNode('c') }),
      ]);
      expect(document.boundJoinCalls).toHaveLength(1);
      await expect(new Promise(resolve => data.getProperty('metadata', resolve))).resolves.toEqual({
        state: expect.any(MetadataValidationState),
        cardinality: { type: 'estimate', value: 10 },
        variables: [
          { variable: DF.variable('x'), canBeUndef: false },
          { variable: DF.variable('y'), canBeUndef: false },
          { variable: DF.variable('other'), canBeUndef: false },
        ],
      });
    });

    it('should read pushed-binding results across several buffer fills', async() => {
      const small = new QuerySourceCottas('s', document, DF, BF, 1, 8192);
      const data = small.queryBindings(pattern(DF.variable('x'), DF.variable('y')), ctx, {
        joinBindings: push([{ x: DF.namedNode('a') }, { x: DF.namedNode('b') }], 'x'),
      });
      await expect(data.toArray()).resolves.toHaveLength(2);
    });

    it('should push bindings into a whole basic graph pattern', async() => {
      const data = joined.queryBindings(AF.createJoin([
        pattern(DF.variable('x'), DF.variable('y')),
        pattern(DF.variable('y'), DF.variable('z')),
      ]), ctx, { joinBindings: push([{ x: DF.namedNode('a') }, { maybe: DF.namedNode('b') }], 'x', 'maybe') });
      await expect(data).toEqualBindingsStream([
        BF.fromRecord({ x: DF.namedNode('a'), y: DF.namedNode('b'), z: DF.namedNode('c') }),
        BF.fromRecord({ maybe: DF.namedNode('b'), x: DF.namedNode('a'), y: DF.namedNode('b'), z: DF.namedNode('c') }),
        BF.fromRecord({ maybe: DF.namedNode('b'), x: DF.blankNode('n'), y: DF.namedNode('a'), z: DF.namedNode('b') }),
      ]);
    });

    it('should return only the pattern\'s own solutions when filtering', async() => {
      const data = joined.queryBindings(pattern(DF.variable('x'), DF.variable('y')), ctx, {
        filterBindings: push([{ y: DF.namedNode('c') }], 'y'),
      });
      await expect(data).toEqualBindingsStream([
        BF.fromRecord({ x: DF.namedNode('b'), y: DF.namedNode('c') }),
      ]);
      await expect(new Promise(resolve => data.getProperty('metadata', resolve))).resolves.toMatchObject({
        variables: [
          { variable: DF.variable('x'), canBeUndef: false },
          { variable: DF.variable('y'), canBeUndef: false },
        ],
      });
    });

    it('should reject pushed bindings for an operation that is not a pattern or join', () => {
      expect(() => joined.queryBindings(AF.createNop(), ctx, { joinBindings: push([]) }))
        .toThrow(`Attempted to pass non-pattern operation 'nop' to QuerySourceCottas`);
    });

    describe('with blank nodes', () => {
      const own = (label: string) => new BlankNodeScoped(
        `bc_0_${label}`,
        DF.namedNode(`urn:comunica_skolem:source_0:${label}`),
      );
      const foreign = (label: string) => new BlankNodeScoped(
        `bc_1_${label}`,
        DF.namedNode(`urn:comunica_skolem:source_1:${label}`),
      );
      const skolemContext = new ActionContext({
        [KeysQuerySourceIdentify.sourceIds.name]: new Map([[ 'j', '0' ], [ 'other', '1' ]]),
      });
      const objectsOf = async(records: Record<string, RDF.Term>[], context = skolemContext): Promise<string[]> =>
        (await joined.queryBindings(pattern(DF.variable('x'), DF.variable('y')), context, {
          joinBindings: push(records, 'x'),
        }).toArray()).map(bindings => bindings.get('y')!.value);

      it('should match its own skolemized blank nodes against the file', async() => {
        await expect(objectsOf([{ x: own('n') }])).resolves.toEqual([ 'a' ]);
        await expect(objectsOf([{ x: DF.namedNode('urn:comunica_skolem:source_0:n') }])).resolves.toEqual([ 'a' ]);
      });

      it('should match nothing for blank nodes of other sources', async() => {
        await expect(objectsOf([{ x: foreign('n') }, { x: DF.namedNode('a') }])).resolves.toEqual([ 'b' ]);
        expect(document.boundJoinCalls[0]).toHaveLength(1);
        // Without skolemization, a skolem IRI belongs to no source this one knows of.
        await expect(objectsOf([{ x: own('n') }], ctx)).resolves.toEqual([]);
      });

      it('should pass plain blank nodes through as the document\'s own', async() => {
        await expect(objectsOf([{ x: DF.blankNode('n') }])).resolves.toEqual([ 'a' ]);
      });

      it('should localize blank nodes inside quoted triples', async() => {
        await objectsOf([
          { x: DF.quad(own('n'), knows, DF.namedNode('a')) },
          { x: DF.quad(foreign('n'), knows, DF.namedNode('a')) },
        ]);
        expect([ ...document.boundJoinCalls[0] ].map(row => row.get('x'))).toEqual([
          DF.quad(DF.blankNode('n'), knows, DF.namedNode('a')),
        ]);
      });
    });

    it('should end when the document was closed', async() => {
      await document.close();
      const data = joined.queryBindings(pattern(DF.variable('x'), DF.variable('y')), ctx, {
        joinBindings: push([{ x: DF.namedNode('a') }], 'x'),
      });
      await expect(data).toEqualBindingsStream([]);
    });

    it('should report a failing document as a stream error', async() => {
      document.setError(new Error('broken'));
      const data = joined.queryBindings(pattern(DF.variable('x'), DF.variable('y')), ctx, {
        filterBindings: push([{ x: DF.namedNode('a') }], 'x'),
      });
      await expect(data.toArray()).rejects.toThrow('broken');
    });

    it('should close its cursor when the consumer stops early', async() => {
      const data = joined.queryBindings(pattern(DF.variable('x'), DF.variable('y')), ctx, {
        joinBindings: push([{ x: DF.namedNode('a') }, { x: DF.namedNode('b') }], 'x'),
      });
      await new Promise(resolve => data.once('data', resolve));
      data.destroy();
      await new Promise(resolve => setImmediate(resolve));
      expect(document.joinClosed).toBe(true);
    });

    it('should report the configured request time for patterns and joins', async() => {
      const timed = new QuerySourceCottas('t', document, DF, BF, 128, 8192, 12);
      const metadataOf = async(operation: Algebra.Operation) => {
        const stream = timed.queryBindings(operation, ctx);
        const metadata = await new Promise(resolve => stream.getProperty('metadata', resolve));
        stream.destroy();
        return metadata;
      };
      await expect(metadataOf(pattern(DF.variable('x'), DF.variable('y'))))
        .resolves.toMatchObject({ requestTime: 12 });
      await expect(metadataOf(AF.createJoin([ pattern(DF.variable('x'), DF.variable('y')) ])))
        .resolves.toMatchObject({ requestTime: 12 });
    });
  });

  describe('getFilterFactor', () => {
    it('should return a string representation', async() => {
      await expect(source.getFilterFactor(ctx)).resolves.toBe(1);
    });
  });

  describe('toString', () => {
    it('should return a string representation', async() => {
      expect(source.toString()).toBe('QuerySourceCottas(path)');
    });
  });

  describe('queryQuads', () => {
    it('should throw', () => {
      expect(() => source.queryQuads(<any> undefined, ctx))
        .toThrow(`queryQuads is not implemented in QuerySourceCottas`);
    });

    describe('queryBindings', () => {
      it('should throw when passing non-pattern', async() => {
        expect(() => source.queryBindings(
          AF.createNop(),
          ctx,
        )).toThrow(`Attempted to pass non-pattern operation 'nop' to QuerySourceCottas`);
      });

      it('should return triples in the default graph', async() => {
        const data = source.queryBindings(
          AF.createPattern(DF.variable('s'), DF.namedNode('p'), DF.variable('o')),
          ctx,
        );
        await expect(data).toEqualBindingsStream([
          BF.fromRecord({
            s: DF.namedNode('s1'),
            o: DF.namedNode('o1'),
          }),
          BF.fromRecord({
            s: DF.namedNode('s2'),
            o: DF.namedNode('o2'),
          }),
        ]);
        await expect(new Promise(resolve => data.getProperty('metadata', resolve))).resolves
          .toEqual({
            cardinality: { type: 'exact', value: 2 },
            state: expect.any(MetadataValidationState),
            variables: [
              {
                variable: DF.variable('s'),
                canBeUndef: false,
              },
              {
                variable: DF.variable('o'),
                canBeUndef: false,
              },
            ],
          });
      });

      it('should not return triples in a named graph', async() => {
        const data = source.queryBindings(
          AF.createPattern(DF.variable('s'), DF.namedNode('p'), DF.variable('o'), DF.namedNode('g1')),
          ctx,
        );
        await expect(data).toEqualBindingsStream([]);
        await expect(new Promise(resolve => data.getProperty('metadata', resolve))).resolves
          .toEqual({
            cardinality: { type: 'exact', value: 0 },
            state: expect.any(MetadataValidationState),
            variables: [
              { variable: DF.variable('s'), canBeUndef: false },
              { variable: DF.variable('o'), canBeUndef: false },
            ],
          });
      });

      it('should read the default graph as the union of all graphs from the context', async() => {
        const quadDocument = new MockedCottasDocument([
          DF.quad(DF.namedNode('s1'), DF.namedNode('p'), DF.namedNode('o1')),
          DF.quad(DF.namedNode('s2'), DF.namedNode('p'), DF.namedNode('o2'), DF.namedNode('g2')),
        ]);
        const quadSource = new QuerySourceCottas('quads', quadDocument, DF, BF, 128, 8192);
        const pattern = AF.createPattern(DF.variable('s'), DF.namedNode('p'), DF.variable('o'));

        // Without the context entry only the default graph is visible.
        await expect(quadSource.queryBindings(pattern, ctx)).toEqualBindingsStream([
          BF.fromRecord({ s: DF.namedNode('s1'), o: DF.namedNode('o1') }),
        ]);

        await expect(quadSource.queryBindings(
          pattern,
          new ActionContext({ [KeysQueryOperation.unionDefaultGraph.name]: true }),
        )).toEqualBindingsStream([
          BF.fromRecord({ s: DF.namedNode('s1'), o: DF.namedNode('o1') }),
          BF.fromRecord({ s: DF.namedNode('s2'), o: DF.namedNode('o2') }),
        ]);
      });

      it('should return and bind named graphs from a quad table', async() => {
        const quadDocument = new MockedCottasDocument([
          DF.quad(DF.namedNode('s1'), DF.namedNode('p'), DF.namedNode('o1'), DF.namedNode('g1')),
          DF.quad(DF.namedNode('s2'), DF.namedNode('p'), DF.namedNode('o2'), DF.namedNode('g2')),
        ]);
        const quadSource = new QuerySourceCottas('quads', quadDocument, DF, BF, 128, 8192);
        const data = quadSource.queryBindings(AF.createPattern(
          DF.variable('s'),
          DF.namedNode('p'),
          DF.variable('o'),
          DF.variable('g'),
        ), ctx);
        await expect(data).toEqualBindingsStream([
          BF.fromRecord({ s: DF.namedNode('s1'), o: DF.namedNode('o1'), g: DF.namedNode('g1') }),
          BF.fromRecord({ s: DF.namedNode('s2'), o: DF.namedNode('o2'), g: DF.namedNode('g2') }),
        ]);
      });
    });
  });

  describe('queryBoolean', () => {
    it('should throw', () => {
      expect(() => source.queryBoolean(<any> undefined, ctx))
        .toThrow(`queryBoolean is not implemented in QuerySourceCottas`);
    });
  });

  describe('queryVoid', () => {
    it('should throw', () => {
      expect(() => source.queryVoid(<any> undefined, ctx))
        .toThrow(`queryVoid is not implemented in QuerySourceCottas`);
    });
  });

  describe('dispose', () => {
    it('should close the document exactly once', async() => {
      const close = jest.spyOn(cottasDocument, 'close');
      await source.dispose();
      await source.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
