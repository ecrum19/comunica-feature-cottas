import type { ActorHttpInvalidateListenable, IActionHttpInvalidate } from '@comunica/bus-http-invalidate';
import type { MediatorMergeBindingsContext } from '@comunica/bus-merge-bindings-context';
import type {
  IActionQuerySourceIdentify,
  IActorQuerySourceIdentifyOutput,
  IActorQuerySourceIdentifyArgs,
} from '@comunica/bus-query-source-identify';
import {
  ActorQuerySourceIdentify,
} from '@comunica/bus-query-source-identify';
import { KeysInitQuery } from '@comunica/context-entries';
import type { IActorTest, TestResult } from '@comunica/core';
import { ActionContext, failTest, passTestVoid } from '@comunica/core';
import type { ComunicaDataFactory } from '@comunica/types';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type { CottasDocument } from './CottasDocument';
import { openCottasDocument } from './CottasDocument';
import { QuerySourceCottas } from './QuerySourceCottas';

/**
 * A comunica Cottas Query Source Identify Actor.
 */
export class ActorQuerySourceIdentifyCottas extends ActorQuerySourceIdentify {
  public readonly httpInvalidator: ActorHttpInvalidateListenable;
  private createdSources: WeakRef<QuerySourceCottas>[] = [];

  public readonly mediatorMergeBindingsContext: MediatorMergeBindingsContext;
  public readonly maxBufferSize: number;
  public readonly pageSize: number;

  public constructor(args: IActorQuerySourceIdentifyCottasArgs) {
    super(args);
    this.httpInvalidator = args.httpInvalidator;
    this.mediatorMergeBindingsContext = args.mediatorMergeBindingsContext;
    this.maxBufferSize = args.maxBufferSize;
    this.pageSize = args.pageSize;
    this.httpInvalidator.addInvalidateListener(
      ({ url }: IActionHttpInvalidate) => {
        // eslint-disable-next-line ts/no-floating-promises
        this.clearCache(url);
      },
    );
  }

  public async test(action: IActionQuerySourceIdentify): Promise<TestResult<IActorTest>> {
    const source = action.querySourceUnidentified;
    if (source.type !== 'cottas') {
      return failTest(`${this.name} requires a single query source with cottas type to be present in the context.`);
    }
    if (typeof source.value !== 'string') {
      return failTest(`${this.name} received an invalid cottas query source.`);
    }
    return passTestVoid();
  }

  public async run(action: IActionQuerySourceIdentify): Promise<IActorQuerySourceIdentifyOutput> {
    const dataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    const path = <string> action.querySourceUnidentified.value;
    const source = new QuerySourceCottas(
      path,
      await this.openDocument(path, dataFactory),
      dataFactory,
      await BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory),
      this.maxBufferSize,
      this.pageSize,
    );
    this.createdSources.push(new WeakRef(source));

    return {
      querySource: {
        source,
        context: action.querySourceUnidentified.context ?? new ActionContext(),
      },
    };
  }

  protected async openDocument(path: string, dataFactory: ComunicaDataFactory): Promise<CottasDocument> {
    return openCottasDocument(path, dataFactory);
  }

  public async clearCache(referenceValue?: string): Promise<void> {
    const retainedSources: WeakRef<QuerySourceCottas>[] = [];
    for (const sourceReference of this.createdSources) {
      const source = sourceReference.deref();
      if (source && (!referenceValue || source.referenceValue === referenceValue)) {
        await source.dispose();
      } else if (source) {
        retainedSources.push(sourceReference);
      }
    }
    this.createdSources = retainedSources;
  }
}

export interface IActorQuerySourceIdentifyCottasArgs extends IActorQuerySourceIdentifyArgs {
  /* eslint-disable max-len */
  /**
   * An actor that listens to HTTP invalidation events
   * @default {<default_invalidator> a <npmd:@comunica/bus-http-invalidate/^5.0.0/components/ActorHttpInvalidateListenable.jsonld#ActorHttpInvalidateListenable>}
   */
  httpInvalidator: ActorHttpInvalidateListenable;
  /* eslint-enable max-len */
  /**
   * A mediator for creating binding context merge handlers
   */
  mediatorMergeBindingsContext: MediatorMergeBindingsContext;
  /**
   * The number of bindings this actor's iterators buffer ahead of their consumer.
   * @default {128}
   */
  maxBufferSize: number;
  /**
   * The number of bindings to request from a COTTAS file in a single call.
   * Every call is a separate scan of the file that seeks to its offset, and that seek is linear in
   * the offset, so small pages make a full traversal quadratic. Pages grow from the buffer size up
   * to this value.
   * @range {integer}
   * @default {8192}
   */
  pageSize: number;
}
