import type { MediatorMergeBindingsContext } from '@comunica/bus-merge-bindings-context';
import type {
  IActionRdfJoin,
  IActorRdfJoinArgs,
  IActorRdfJoinOutputInner,
  IActorRdfJoinTestSideData,
  MediatorRdfJoin,
} from '@comunica/bus-rdf-join';
import { ActorRdfJoin } from '@comunica/bus-rdf-join';
import type { MediatorRdfJoinEntriesSort } from '@comunica/bus-rdf-join-entries-sort';
import { KeysInitQuery } from '@comunica/context-entries';
import type { TestResult } from '@comunica/core';
import { failTest, passTest, passTestWithSideData } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
import type {
  Bindings,
  BindingsStream,
  IActionContext,
  IJoinEntry,
  IJoinEntryWithMetadata,
  IQueryOperationResultBindings,
  IQuerySourceWrapper,
} from '@comunica/types';
import { Algebra, AlgebraFactory, isKnownOperation } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { ChunkedIterator } from '@comunica/utils-iterator';
import {
  doesShapeAcceptOperation,
  getOperationSource,
  materializeOperation,
} from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { ArrayIterator, TransformIterator, UnionIterator } from 'asynciterator';

/**
 * A Comunica inner join actor that pushes blocks of bindings into the sources of another entry,
 * also when that entry is spread over several sources.
 *
 * Comunica's `bind-source` actor sends a block of the smallest entry's bindings to the source of the
 * remaining entries in one request, but only when all of those share a single source. Once a query
 * runs over several sources, every triple pattern that matches more than one of them becomes a
 * union of per-source patterns, and the only bind join left sends one request per binding. That is
 * ruinous for sources where every request has a fixed cost, such as a SPARQL endpoint or a file read
 * through DuckDB.
 *
 * This actor binds into a union as well: each block goes to every branch of the union, and the
 * results are unioned again, which is the bound join of FedX. With several remaining entries over
 * different sources it binds the best-connected one only and hands the rest back to the join bus,
 * building a left-deep plan. A branch whose source can not take bindings is bound one binding at a
 * time instead, so sources of any kind can be mixed.
 *
 * Bindings holding a blank node are always bound one at a time. A source answering a block returns
 * the pushed bindings merged with its own results, and Comunica re-skolemizes every blank node in
 * that output as if it came from that source, which would rename blank nodes of other sources.
 */
export class ActorRdfJoinMultiBindSources extends ActorRdfJoin<IActorRdfJoinMultiBindSourcesTestSideData> {
  public readonly selectivityModifier: number;
  public readonly blockSize: number;
  public readonly mediatorJoinEntriesSort: MediatorRdfJoinEntriesSort;
  public readonly mediatorJoin: MediatorRdfJoin;
  public readonly mediatorMergeBindingsContext: MediatorMergeBindingsContext;

  public constructor(args: IActorRdfJoinMultiBindSourcesArgs) {
    super(args, {
      logicalType: 'inner',
      physicalName: 'bind-sources',
      canHandleUndefs: true,
      isLeaf: false,
      pushesBindingsToSource: true,
    });
    this.selectivityModifier = args.selectivityModifier;
    this.blockSize = args.blockSize;
    this.mediatorJoinEntriesSort = args.mediatorJoinEntriesSort;
    this.mediatorJoin = args.mediatorJoin;
    this.mediatorMergeBindingsContext = args.mediatorMergeBindingsContext;
  }

  /** Whether a term is, or contains, a blank node. */
  public static hasBlankNode(term: RDF.Term): boolean {
    if (term.termType === 'Quad') {
      return [ term.subject, term.predicate, term.object, term.graph ].some(ActorRdfJoinMultiBindSources.hasBlankNode);
    }
    return term.termType === 'BlankNode';
  }

  /**
   * Split an operation into the source-annotated operations it is the union of.
   * Returns undefined if part of it has no single source.
   */
  public static branchesOf(operation: Algebra.Operation): ISourceOperation[] | undefined {
    const source = getOperationSource(operation);
    if (source) {
      return [{ operation, source }];
    }
    if (isKnownOperation(operation, Algebra.Types.UNION) && operation.input.length > 0) {
      const branches = operation.input.map(input => ActorRdfJoinMultiBindSources.branchesOf(input));
      if (branches.every(branch => branch !== undefined)) {
        return branches.flat();
      }
    }
    return undefined;
  }

  public override async getOutput(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinMultiBindSourcesTestSideData,
  ): Promise<IActorRdfJoinOutputInner> {
    const dataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    const algebraFactory = new AlgebraFactory(dataFactory);
    const bindingsFactory = await BindingsFactory
      .create(this.mediatorMergeBindingsContext, action.context, dataFactory);
    const { first, target, remaining } = sideData;

    // The bound entries are evaluated again through the bind join, so their own results are unused.
    for (const entry of target.entries) {
      entry.output.bindingsStream.destroy();
    }

    const bound: IQueryOperationResultBindings = {
      type: 'bindings',
      bindingsStream: this.createBindStream(first, target, action.context, algebraFactory, bindingsFactory),
      metadata: () => this.constructResultMetadata(
        [ first, ...target.entries ],
        [ first.metadata, ...target.entries.map(entry => entry.metadata) ],
        action.context,
      ),
    };
    const physicalPlanMetadata = {
      bindIndex: sideData.entriesUnsorted.indexOf(first),
      bindTargets: target.entries.map(entry => sideData.entriesUnsorted.indexOf(entry)),
      branches: target.branches.length,
      blockSize: this.blockSize,
    };
    if (remaining.length === 0) {
      return { result: bound, physicalPlanMetadata };
    }

    // Left-deep: the bound pair becomes one entry, joined with the others by whichever actor fits.
    const boundEntry: IJoinEntry = {
      output: bound,
      operation: algebraFactory.createJoin([ first.operation, target.operation ], false),
      operationModified: true,
    };
    return {
      result: await this.mediatorJoin.mediate({
        type: action.type,
        entries: [ boundEntry, ...remaining ],
        context: action.context,
      }),
      physicalPlanMetadata,
    };
  }

  /** Bind every block of the first entry's bindings into all branches of the target. */
  public createBindStream(
    first: IJoinEntryWithMetadata,
    target: IBindTarget,
    context: IActionContext,
    algebraFactory: AlgebraFactory,
    bindingsFactory: BindingsFactory,
  ): BindingsStream {
    const chunks = new ChunkedIterator(first.output.bindingsStream, this.blockSize, { autoStart: false });
    return new UnionIterator(chunks.map<AsyncIterator<Bindings>>(chunk => new TransformIterator<Bindings>(async() => {
      const block = await chunk.toArray();
      const plain = block.filter(bindings => ![ ...bindings.values() ].some(ActorRdfJoinMultiBindSources.hasBlankNode));
      const blank = block.filter(bindings => !plain.includes(bindings));
      const streams: (() => BindingsStream)[] = [];
      for (const branch of target.branches) {
        const branchContext = branch.source.context ? context.merge(branch.source.context) : context;
        if (branch.acceptsBindings && plain.length > 0) {
          streams.push(() => branch.source.source.queryBindings(branch.operation, branchContext, {
            joinBindings: { bindings: new ArrayIterator(plain, { autoStart: false }), metadata: first.metadata },
          }));
        }
        for (const bindings of branch.acceptsBindings ? blank : block) {
          streams.push(() => branch.source.source.queryBindings(
            materializeOperation(branch.operation, bindings, algebraFactory, bindingsFactory, { bindFilter: true }),
            branchContext,
          ).map(result => result.merge(bindings) ?? null));
        }
      }
      return new UnionIterator(
        new ArrayIterator(streams, { autoStart: false }).map(stream => stream()),
        { autoStart: false },
      );
    }, { autoStart: false })), { autoStart: false });
  }

  protected async sortJoinEntries(
    entries: IJoinEntryWithMetadata[],
    context: IActionContext,
  ): Promise<TestResult<IJoinEntryWithMetadata[]>> {
    const entriesTest = await ActorRdfJoin.sortJoinEntries(this.mediatorJoinEntriesSort, entries, context);
    if (entriesTest.isFailed()) {
      return entriesTest;
    }
    // Prioritize entries with modified operations, so these are not re-executed.
    return passTest([ ...entriesTest.get() ].sort((left, right) => {
      if (left.operationModified && !right.operationModified) {
        return -1;
      }
      return 0;
    }));
  }

  /**
   * Choose what to bind into: all remaining entries at once if they share one source, as
   * `bind-source` does, or else the remaining entry that shares the most variables with the first.
   */
  protected async chooseTarget(
    first: IJoinEntryWithMetadata,
    others: IJoinEntryWithMetadata[],
    context: IActionContext,
    algebraFactory: AlgebraFactory,
  ): Promise<TestResult<{ target: IBindTarget; remaining: IJoinEntryWithMetadata[] }>> {
    const sources = others.map(entry => getOperationSource(entry.operation));
    if (sources.every(source => source && source === sources[0])) {
      const operation = others.length === 1 ?
        others[0].operation :
        algebraFactory.createJoin(others.map(entry => entry.operation), true);
      const branches = await this.testBranches([{ operation, source: sources[0]! }], context);
      return branches.isPassed() ?
        passTest({ target: { entries: others, operation, branches: branches.get() }, remaining: []}) :
        branches;
    }

    const shared = (entry: IJoinEntryWithMetadata): number => entry.metadata.variables
      .filter(variable => first.metadata.variables.some(known => known.variable.equals(variable.variable))).length;
    const candidates = others
      .filter(entry => !entry.operationModified && shared(entry) > 0)
      .sort((left, right) => shared(right) - shared(left) ||
        left.metadata.cardinality.value - right.metadata.cardinality.value);
    for (const candidate of candidates) {
      const split = ActorRdfJoinMultiBindSources.branchesOf(candidate.operation);
      if (split) {
        const branches = await this.testBranches(split, context);
        if (branches.isPassed()) {
          return passTest({
            target: { entries: [ candidate ], operation: candidate.operation, branches: branches.get() },
            remaining: others.filter(entry => entry !== candidate),
          });
        }
      }
    }
    return failTest(`Actor ${this.name} found no entry connected to the first one whose sources accept bindings`);
  }

  /** Check which branches accept a block of bindings; at least one must, or a per-binding join is as good. */
  protected async testBranches(
    branches: ISourceOperation[],
    context: IActionContext,
  ): Promise<TestResult<IBindBranch[]>> {
    const wildcardAcceptAllExtensionFunctions = context.get(KeysInitQuery.extensionFunctionsAlwaysPushdown);
    const tested = await Promise.all(branches.map(async({ operation, source }) => ({
      operation,
      source,
      acceptsBindings: doesShapeAcceptOperation(await source.source.getSelectorShape(context), operation, {
        joinBindings: true,
        wildcardAcceptAllExtensionFunctions,
      }),
    })));
    if (!tested.some(branch => branch.acceptsBindings)) {
      return failTest(`Actor ${this.name} can only bind into sources that accept join bindings`);
    }
    return passTest(tested);
  }

  public override async getJoinCoefficients(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinTestSideData,
  ): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinMultiBindSourcesTestSideData>> {
    const dataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    const algebraFactory = new AlgebraFactory(dataFactory);
    const entriesUnsorted = action.entries.map((entry, i) => ({ ...entry, metadata: sideData.metadatas[i] }));
    const entriesTest = await this.sortJoinEntries(entriesUnsorted, action.context);
    if (entriesTest.isFailed()) {
      return entriesTest;
    }
    const [ first, ...others ] = entriesTest.get();
    const choice = await this.chooseTarget(first, others, action.context, algebraFactory);
    if (choice.isFailed()) {
      return choice;
    }
    const { target, remaining } = choice.get();

    // One request per block to every branch that takes bindings, one per binding to the others.
    const cardinalityFirst = first.metadata.cardinality.value;
    const blocks = Math.ceil(cardinalityFirst / this.blockSize);
    const perBinding = target.branches.filter(branch => !branch.acceptsBindings).length;
    const requests = ((target.branches.length - perBinding) * blocks + perBinding * cardinalityFirst) /
      target.branches.length;
    const metadatas = [ first.metadata, ...target.entries.map(entry => entry.metadata) ];
    const [ initialFirst, ...initialTarget ] = ActorRdfJoin.getRequestInitialTimes(metadatas);
    const [ itemFirst, ...itemTarget ] = ActorRdfJoin.getRequestItemTimes(metadatas);
    const cardinalityJoined = await this.estimateJoinCardinality(action.context, first, target.entries);
    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

    return passTestWithSideData({
      iterations: cardinalityFirst + cardinalityJoined +
        sum(remaining.map(entry => entry.metadata.cardinality.value)),
      persistedItems: Math.min(cardinalityFirst, this.blockSize),
      blockingItems: Math.min(cardinalityFirst, this.blockSize),
      requestTime: initialFirst + cardinalityFirst * itemFirst +
        requests * sum(initialTarget) + cardinalityJoined * sum(itemTarget),
    }, { ...sideData, entriesUnsorted, first, target, remaining });
  }

  /** Estimate how many bindings binding the first entry into the target produces. */
  protected async estimateJoinCardinality(
    context: IActionContext,
    first: IJoinEntryWithMetadata,
    targets: IJoinEntryWithMetadata[],
  ): Promise<number> {
    const shared = ActorRdfJoin
      .getSharedVariableJoinCardinality([ first.metadata, ...targets.map(entry => entry.metadata) ]);
    if (shared !== undefined) {
      return shared;
    }
    const { selectivity } = await this.mediatorJoinSelectivity.mediate({ entries: [ first, ...targets ], context });
    return [ first, ...targets ].reduce((product, entry) => product * entry.metadata.cardinality.value, 1) *
      selectivity * this.selectivityModifier;
  }
}

/** An operation together with the one source that evaluates it. */
export interface ISourceOperation {
  operation: Algebra.Operation;
  source: IQuerySourceWrapper;
}

/** A source-annotated operation the bindings are pushed into. */
export interface IBindBranch extends ISourceOperation {
  /** Whether the source takes a block of bindings for this operation, or must be bound one at a time. */
  acceptsBindings: boolean;
}

/** What a block of bindings is pushed into. */
export interface IBindTarget {
  /** The join entries evaluated through the bind join. */
  entries: IJoinEntryWithMetadata[];
  /** Their combined operation. */
  operation: Algebra.Operation;
  /** The single-source operations that operation is the union of. */
  branches: IBindBranch[];
}

export interface IActorRdfJoinMultiBindSourcesArgs
  extends IActorRdfJoinArgs<IActorRdfJoinMultiBindSourcesTestSideData> {
  /**
   * Multiplier for selectivity values
   * @range {double}
   * @default {0.0001}
   */
  selectivityModifier: number;
  /**
   * The maximum number of bindings sent to a source per request.
   * Larger blocks need fewer requests, but delay the first results and grow every request.
   * @range {integer}
   * @default {256}
   */
  blockSize: number;
  /**
   * The join entries sort mediator
   */
  mediatorJoinEntriesSort: MediatorRdfJoinEntriesSort;
  /**
   * The join mediator, which joins the bound pair with the entries not bound into
   */
  mediatorJoin: MediatorRdfJoin;
  /**
   * A mediator for creating binding context merge handlers
   */
  mediatorMergeBindingsContext: MediatorMergeBindingsContext;
}

export interface IActorRdfJoinMultiBindSourcesTestSideData extends IActorRdfJoinTestSideData {
  entriesUnsorted: IJoinEntryWithMetadata[];
  first: IJoinEntryWithMetadata;
  target: IBindTarget;
  remaining: IJoinEntryWithMetadata[];
}
