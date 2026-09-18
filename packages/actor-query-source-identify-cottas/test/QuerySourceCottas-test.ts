import { KeysQueryOperation } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
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
    it('should return a selector shape', async() => {
      await expect(source.getSelectorShape()).resolves.toEqual({
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
      });
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
