import type { ActorHttpInvalidateListenable } from '@comunica/bus-http-invalidate';
import { ActorQuerySourceIdentify } from '@comunica/bus-query-source-identify';
import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import { DataFactory } from 'rdf-data-factory';
import { ActorQuerySourceIdentifyCottas } from '../lib/ActorQuerySourceIdentifyCottas';
import { QuerySourceCottas } from '../lib/QuerySourceCottas';
import 'jest-rdf';
import { MockedCottasDocument } from './MockedCottasDocument';
import '@comunica/utils-jest';

const mediatorMergeBindingsContext: any = {
  mediate(_arg: any) {
    return {};
  },
};

const DF = new DataFactory();

describe('ActorQuerySourceIdentifyCottas', () => {
  let bus: any;
  let httpInvalidator: ActorHttpInvalidateListenable;
  let cottasDocument: MockedCottasDocument;
  let openDocumentSpy: jest.SpyInstance;
  let listener: any = null;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    cottasDocument = new MockedCottasDocument([]);
    jest.spyOn(cottasDocument, 'close');
    openDocumentSpy = jest.spyOn(<any> ActorQuerySourceIdentifyCottas.prototype, 'openDocument')
      .mockResolvedValue(cottasDocument);
    httpInvalidator = <any>{
      addInvalidateListener: (l: any) => listener = l,
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('The ActorQuerySourceIdentifyCottas module', () => {
    it('should be a function', () => {
      expect(ActorQuerySourceIdentifyCottas).toBeInstanceOf(Function);
    });

    it('should be a ActorQuerySourceIdentifyCottas constructor', () => {
      expect(new (<any> ActorQuerySourceIdentifyCottas)({ name: 'actor', bus, httpInvalidator }))
        .toBeInstanceOf(ActorQuerySourceIdentifyCottas);
      expect(new (<any> ActorQuerySourceIdentifyCottas)({ name: 'actor', bus, httpInvalidator }))
        .toBeInstanceOf(ActorQuerySourceIdentify);
    });

    it('should not be able to create new ActorQuerySourceIdentifyCottas objects without \'new\'', () => {
      expect(() => {
        (<any> ActorQuerySourceIdentifyCottas)();
      }).toThrow(`Class constructor ActorQuerySourceIdentifyCottas cannot be invoked without 'new'`);
    });
  });

  describe('An ActorQuerySourceIdentifyCottas instance', () => {
    let actor: ActorQuerySourceIdentifyCottas;

    beforeEach(() => {
      actor = new ActorQuerySourceIdentifyCottas({
        name: 'actor',
        bus,
        httpInvalidator,
        mediatorMergeBindingsContext,
        maxBufferSize: 128,
        pageSize: 8192,
      });
    });

    describe('test', () => {
      it('should test', async() => {
        await expect(actor.test({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: new ActionContext(),
        })).resolves.toPassTestVoid();
      });

      it.each([ 'hdt', 'sparql', 'rdfjs', 'file' ])('should not test with %s type', async(type) => {
        await expect(actor.test({
          querySourceUnidentified: { type, value: 'bla' },
          context: new ActionContext(),
        })).resolves.toFailTest(`actor requires a single query source with cottas type to be present in the context.`);
      });

      it('should not test with invalid source value', async() => {
        await expect(actor.test({
          querySourceUnidentified: { type: 'cottas', value: <any>{}},
          context: new ActionContext(),
        })).resolves.toFailTest(`actor received an invalid cottas query source.`);
      });
    });

    describe('run', () => {
      it('should get the source', async() => {
        const contextIn = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
        const ret = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        expect(ret.querySource.source).toBeInstanceOf(QuerySourceCottas);
        expect(ret.querySource.context).not.toBe(contextIn);
      });

      it('should forward the buffer and page sizes to the source', async() => {
        const ret = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: new ActionContext({ [KeysInitQuery.dataFactory.name]: DF }),
        });
        expect((<any> ret.querySource.source).maxBufferSize).toBe(128);
        expect((<any> ret.querySource.source).pageSize).toBe(8192);
      });

      it('should get the source with context', async() => {
        const contextIn = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
        const contextSource = new ActionContext();
        const ret = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/', context: contextSource },
          context: contextIn,
        });
        expect(ret.querySource.source).toBeInstanceOf(QuerySourceCottas);
        expect(ret.querySource.context).not.toBe(contextIn);
        expect(ret.querySource.context).toBe(contextSource);
      });

      it('should expose an actionable error for a missing source', async() => {
        openDocumentSpy.mockRestore();
        await expect(actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: new ActionContext({ [KeysInitQuery.dataFactory.name]: DF }),
        })).rejects.toThrow('Unable to access COTTAS file');
      });

      it('should get the same source', async() => {
        const contextIn = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
        const ret1 = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        const ret2 = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        expect((<any> ret1.querySource.source).cottasDocument).toBe((<any> ret2.querySource.source).cottasDocument);
      });

      it('should get the same source after cache invalidation for one url', async() => {
        const contextIn = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
        const ret1 = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        await listener({ url: 'x' });
        expect((<any> ret1.querySource.source).cottasDocument.close).toHaveBeenCalledTimes(0);
        const ret2 = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        expect((<any> ret1.querySource.source).cottasDocument).toBe((<any> ret2.querySource.source).cottasDocument);
      });

      it('should get the same source after cache invalidation for all urls', async() => {
        const contextIn = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
        const ret1 = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        await listener({});
        expect((<any> ret1.querySource.source).cottasDocument.close).toHaveBeenCalledTimes(1);
        const ret2 = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        expect((<any> ret1.querySource.source).cottasDocument).toBe((<any> ret2.querySource.source).cottasDocument);
      });

      it('should invalidate a source matching one path', async() => {
        const contextIn = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
        const ret = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path/' },
          context: contextIn,
        });
        await listener({ url: 'path/' });
        expect((<any> ret.querySource.source).cottasDocument.close).toHaveBeenCalledTimes(1);
      });
    });

    describe('clearCache', () => {
      it('runs when no sources were created', async() => {
        await actor.clearCache();
      });

      it('runs when weakrefs are empty', async() => {
        (<any> actor).createdSources.push({
          deref: () => undefined,
        });
        await actor.clearCache();
        expect((<any> actor).createdSources).toEqual([]);
      });

      it('runs with created sources', async() => {
        const { querySource: { source: source1 }} = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path1/', context: new ActionContext() },
          context: new ActionContext({ [KeysInitQuery.dataFactory.name]: DF }),
        });
        const { querySource: { source: source2 }} = await actor.run({
          querySourceUnidentified: { type: 'cottas', value: 'path2/', context: new ActionContext() },
          context: new ActionContext({ [KeysInitQuery.dataFactory.name]: DF }),
        });

        const spy1 = jest.spyOn(<any> source1, 'dispose');
        const spy2 = jest.spyOn(<any> source2, 'dispose');

        await actor.clearCache();
        expect((<any> actor).createdSources).toEqual([]);

        expect(spy1).toHaveBeenCalledTimes(1);
        expect(spy2).toHaveBeenCalledTimes(1);
      });
    });
  });
});
