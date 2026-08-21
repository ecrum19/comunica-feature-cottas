import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'rdf-data-factory';
import { CottasIterator } from '../lib/CottasIterator';
import { MockedCottasDocument } from './MockedCottasDocument';
import '@comunica/utils-jest';

const quad = require('rdf-quad');

const DF = new DataFactory<RDF.BaseQuad>();
const BF = new BindingsFactory(DF);

describe('CottasIterator', () => {
  let cottasDocument: any;

  beforeEach(() => {
    cottasDocument = new MockedCottasDocument([
      quad('s1', 'p1', 'o1'),
      quad('s1', 'p1', 'o2'),
      quad('s1', 'p2', 'o1'),
      quad('s1', 'p2', 'o2'),
      quad('s2', 'p1', 'o1'),
      quad('s2', 'p1', 'o2'),
      quad('s2', 'p2', 'o1'),
      quad('s2', 'p2', 'o2'),
    ]);
  });

  it('should be instantiatable', () => {
    expect(() => new CottasIterator(
      cottasDocument,
      BF,
      DF.namedNode('s1'),
      DF.namedNode('p1'),
      DF.namedNode('o1'),
      { autoStart: false },
    )).not.toThrow();
  });

  it('should return the correct stream for ? ? ?', async() => {
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      {},
    )).toEqualBindingsStream([
      BF.fromRecord({
        s: DF.namedNode('s1'),
        p: DF.namedNode('p1'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s1'),
        p: DF.namedNode('p1'),
        o: DF.namedNode('o2'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s1'),
        p: DF.namedNode('p2'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s1'),
        p: DF.namedNode('p2'),
        o: DF.namedNode('o2'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
        p: DF.namedNode('p1'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
        p: DF.namedNode('p1'),
        o: DF.namedNode('o2'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
        p: DF.namedNode('p2'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
        p: DF.namedNode('p2'),
        o: DF.namedNode('o2'),
      }),
    ]);
  });

  it('should return the correct stream for s1 ? ?', async() => {
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.namedNode('s1'),
      DF.variable('p'),
      DF.variable('o'),
      {},
    )).toEqualBindingsStream([
      BF.fromRecord({
        p: DF.namedNode('p1'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        p: DF.namedNode('p1'),
        o: DF.namedNode('o2'),
      }),
      BF.fromRecord({
        p: DF.namedNode('p2'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        p: DF.namedNode('p2'),
        o: DF.namedNode('o2'),
      }),
    ]);
  });

  it('should return the correct stream for ? p1 ?', async() => {
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.namedNode('p1'),
      DF.variable('o'),
      {},
    )).toEqualBindingsStream([
      BF.fromRecord({
        s: DF.namedNode('s1'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s1'),
        o: DF.namedNode('o2'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
        o: DF.namedNode('o2'),
      }),
    ]);
  });

  it('should return the correct stream for s1 p1 ?', async() => {
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.namedNode('s1'),
      DF.namedNode('p1'),
      DF.variable('o'),
      {},
    )).toEqualBindingsStream([
      BF.fromRecord({
        o: DF.namedNode('o1'),
      }),
      BF.fromRecord({
        o: DF.namedNode('o2'),
      }),
    ]);
  });

  it('should return the correct stream for ? p1 o1', async() => {
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.namedNode('p1'),
      DF.namedNode('o1'),
      {},
    )).toEqualBindingsStream([
      BF.fromRecord({
        s: DF.namedNode('s1'),
      }),
      BF.fromRecord({
        s: DF.namedNode('s2'),
      }),
    ]);
  });

  it('should return the correct stream for s1 p1 o1', async() => {
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.namedNode('s1'),
      DF.namedNode('p1'),
      DF.namedNode('o1'),
      {},
    )).toEqualBindingsStream([
      BF.fromRecord({}),
    ]);
  });

  it('should enforce repeated-variable equality and expose each variable once', async() => {
    const repeated = DF.variable('term');
    const iterator = new CottasIterator(
      cottasDocument,
      BF,
      repeated,
      DF.namedNode('p1'),
      repeated,
      { maxBufferSize: 2 },
    );
    await expect(iterator).toEqualBindingsStream([]);
    await expect(new Promise(resolve => iterator.getProperty('metadata', resolve))).resolves.toMatchObject({
      variables: [{ variable: repeated, canBeUndef: false }],
    });
  });

  it('should page through results without skipping or duplicating rows', async() => {
    const iterator = new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      { maxBufferSize: 2 },
    );
    await expect(iterator).toEqualBindingsStream([
      BF.fromRecord({ s: DF.namedNode('s1'), p: DF.namedNode('p1'), o: DF.namedNode('o1') }),
      BF.fromRecord({ s: DF.namedNode('s1'), p: DF.namedNode('p1'), o: DF.namedNode('o2') }),
      BF.fromRecord({ s: DF.namedNode('s1'), p: DF.namedNode('p2'), o: DF.namedNode('o1') }),
      BF.fromRecord({ s: DF.namedNode('s1'), p: DF.namedNode('p2'), o: DF.namedNode('o2') }),
      BF.fromRecord({ s: DF.namedNode('s2'), p: DF.namedNode('p1'), o: DF.namedNode('o1') }),
      BF.fromRecord({ s: DF.namedNode('s2'), p: DF.namedNode('p1'), o: DF.namedNode('o2') }),
      BF.fromRecord({ s: DF.namedNode('s2'), p: DF.namedNode('p2'), o: DF.namedNode('o1') }),
      BF.fromRecord({ s: DF.namedNode('s2'), p: DF.namedNode('p2'), o: DF.namedNode('o2') }),
    ]);
  });

  it('should not return anything when the document is closed', async() => {
    cottasDocument.close();
    await expect(new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      {},
    )).toEqualBindingsStream([]);
  });

  it('should resolve to an error if the document emits an error', async() => {
    const e = new Error('CottasIterator-test');
    cottasDocument.setError(e);
    await expect(arrayifyStream(new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      {},
    )))
      .rejects.toBe(e);
  });

  it('should expose the metadata property', async() => {
    const it = new CottasIterator(
      cottasDocument,
      BF,
      DF.variable('s'),
      DF.variable('p'),
      DF.variable('o'),
      { autoStart: false },
    );
    const metadata = await new Promise(resolve => it.getProperty('metadata', resolve));
    expect(metadata).toEqual({
      state: new MetadataValidationState(),
      cardinality: { type: 'exact', value: 8 },
      variables: [
        { variable: DF.variable('s'), canBeUndef: false },
        { variable: DF.variable('p'), canBeUndef: false },
        { variable: DF.variable('o'), canBeUndef: false },
      ],
    });
  });

  it('should expose the metadata property for non-exact count', async() => {
    const it = new CottasIterator(
      cottasDocument,
      BF,
      DF.namedNode('s1'),
      DF.namedNode('p1'),
      DF.namedNode('o1'),
      { autoStart: false },
    );
    const metadata = await new Promise(resolve => it.getProperty('metadata', resolve));
    expect(metadata).toEqual({
      state: new MetadataValidationState(),
      cardinality: { type: 'estimate', value: 1 },
      variables: [],
    });
  });
});
