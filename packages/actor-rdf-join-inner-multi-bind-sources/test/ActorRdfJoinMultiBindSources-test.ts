import type { IActionRdfJoin } from '@comunica/bus-rdf-join';
import { ActorRdfJoin } from '@comunica/bus-rdf-join';
import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import type {
  Bindings,
  BindingsStream,
  FragmentSelectorShape,
  IActionContext,
  IJoinEntry,
  IQueryBindingsOptions,
  IQuerySourceWrapper,
} from '@comunica/types';
import { Algebra, AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { assignOperationSource } from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import { ArrayIterator, TransformIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfJoinMultiBindSources } from '../lib/ActorRdfJoinMultiBindSources';
import '@comunica/utils-jest';

const DF = new DataFactory();
const AF = new AlgebraFactory(DF);
const BF = new BindingsFactory(DF);
const v = (name: string): RDF.Variable => DF.variable(name);
const iri = (name: string): RDF.NamedNode => DF.namedNode(name);

/** A minimal in-memory source over triples, optionally accepting blocks of join bindings. */
class TripleSource {
  public readonly referenceValue: string;
  public readonly blockCalls: Bindings[][] = [];
  public readonly singleCalls: Algebra.Operation[] = [];
  private readonly triples: RDF.Quad[];
  private readonly acceptsBindings: boolean;

  public constructor(name: string, triples: [RDF.Term, RDF.Term, RDF.Term][], acceptsBindings: boolean) {
    this.referenceValue = name;
    this.triples = triples.map(([ s, p, o ]) => DF.quad(<any> s, <any> p, <any> o));
    this.acceptsBindings = acceptsBindings;
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    const flags = this.acceptsBindings ? { joinBindings: <const> true } : {};
    const patternShape: FragmentSelectorShape = {
      type: 'operation',
      operation: { operationType: 'pattern', pattern: AF.createPattern(v('s'), v('p'), v('o')) },
      variablesOptional: [ v('s'), v('p'), v('o') ],
      ...flags,
    };
    return {
      type: 'disjunction',
      children: [
        patternShape,
        {
          type: 'operation',
          operation: { operationType: 'type', type: Algebra.Types.JOIN },
          children: [ patternShape ],
          ...flags,
        },
      ],
    };
  }

  public match(operation: Algebra.Operation): Bindings[] {
    if (operation.type === Algebra.Types.JOIN) {
      return (<Algebra.Join> operation).input.reduce<Bindings[]>(
        (joined, input) => joined.flatMap(left => this.match(input).flatMap(right => left.merge(right) ?? [])),
        [ BF.bindings() ],
      );
    }
    const pattern = <Algebra.Pattern> operation;
    return this.triples.flatMap((triple) => {
      let bindings: Bindings | undefined = BF.bindings();
      for (const [ term, value ] of <[RDF.Term, RDF.Term][]>[
        [ pattern.subject, triple.subject ],
        [ pattern.predicate, triple.predicate ],
        [ pattern.object, triple.object ],
      ]) {
        if (term.termType === 'Variable') {
          bindings = bindings?.merge(BF.bindings([[ term, value ]]));
        } else if (!term.equals(value)) {
          bindings = undefined;
        }
      }
      return bindings ? [ bindings ] : [];
    });
  }

  public queryBindings(
    operation: Algebra.Operation,
    _context: IActionContext,
    options?: IQueryBindingsOptions,
  ): BindingsStream {
    const own = this.match(operation);
    if (options?.joinBindings) {
      const pushed = options.joinBindings.bindings;
      return new TransformIterator(async() => {
        const block = await pushed.toArray();
        this.blockCalls.push(block);
        return new ArrayIterator(block.flatMap(left => own.flatMap(right => left.merge(right) ?? [])));
      }, { autoStart: false });
    }
    this.singleCalls.push(operation);
    return new ArrayIterator(own, { autoStart: false });
  }
}

describe('ActorRdfJoinMultiBindSources', () => {
  let bus: any;
  let context: IActionContext;
  let mediatorJoin: any;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    context = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
    mediatorJoin = {
      mediate: jest.fn(async({ entries }: IActionRdfJoin) => {
        // A nested-loop join over materialized entries, standing in for the join bus.
        let joined: Bindings[] = [ BF.bindings() ];
        for (const entry of entries) {
          const right = await entry.output.bindingsStream.toArray();
          joined = joined.flatMap(left => right.flatMap(item => left.merge(item) ?? []));
        }
        return { type: 'bindings', bindingsStream: new ArrayIterator(joined), metadata: entries[0].output.metadata };
      }),
    };
  });

  const createActor = (blockSize = 2) => new ActorRdfJoinMultiBindSources({
    name: 'actor',
    bus,
    selectivityModifier: 0.1,
    blockSize,
    mediatorJoinSelectivity: <any> { mediate: async() => ({ selectivity: 0.5 }) },
    mediatorJoinEntriesSort: <any> {
      mediate: async({ entries }: any) => ({
        entries: [ ...entries ].sort((left: any, right: any) =>
          left.metadata.cardinality.value - right.metadata.cardinality.value),
      }),
    },
    mediatorJoin,
    mediatorMergeBindingsContext: <any> { mediate: async() => ({}) },
  });

  const wrap = (source: TripleSource): IQuerySourceWrapper => ({ source: <any> source });
  const pattern = (s: RDF.Term, p: RDF.Term, o: RDF.Term, wrapper?: IQuerySourceWrapper): Algebra.Pattern => {
    const operation = AF.createPattern(s, p, o);
    return wrapper ? assignOperationSource(operation, wrapper) : operation;
  };
  const entry = (
    operation: Algebra.Operation,
    records: Record<string, RDF.Term>[],
    variables: string[],
    options: { cardinality?: number; modified?: boolean; requestTime?: number; undef?: boolean } = {},
  ): IJoinEntry => ({
    operation,
    operationModified: options.modified,
    output: {
      type: 'bindings',
      bindingsStream: new ArrayIterator(records.map(record => BF.fromRecord(record)), { autoStart: false }),
      metadata: async() => ({
        state: new MetadataValidationState(),
        cardinality: { type: 'exact', value: options.cardinality ?? records.length },
        variables: variables.map(variable => ({ variable: v(variable), canBeUndef: Boolean(options.undef) })),
        ...options.requestTime === undefined ? {} : { requestTime: options.requestTime },
      }),
    },
  });
  const run = async(actor: ActorRdfJoinMultiBindSources, entries: IJoinEntry[]) => {
    const action: IActionRdfJoin = { type: 'inner', entries, context };
    const test = await actor.test(action);
    return { test, action };
  };
  const records = (bindings: Bindings[]): string[] => bindings
    .map(binding => [ ...binding ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join(' '))
    .sort();

  const knows = iri('knows');
  const name = iri('name');
  const people = (...pairs: [string, string][]) => pairs.map(([ a, b ]) => ({ a: iri(a), b: iri(b) }));

  describe('test', () => {
    it('fails without a source to bind into', async() => {
      const { test } = await run(createActor(), [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ]),
        entry(pattern(v('b'), name, v('n')), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      expect(test.isFailed()).toBe(true);
      expect(test.getFailMessage()).toContain('found no entry connected to the first one');
    });

    it('fails when the single source does not accept bindings', async() => {
      const source = wrap(new TripleSource('s', [], false));
      const { test } = await run(createActor(), [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ]),
        entry(pattern(v('b'), name, v('n'), source), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      expect(test.getFailMessage()).toContain('can only bind into sources that accept join bindings');
    });

    it('fails when no union branch accepts bindings', async() => {
      const union = AF.createUnion([
        pattern(v('b'), name, v('n'), wrap(new TripleSource('s0', [], false))),
        pattern(v('b'), name, v('n'), wrap(new TripleSource('s1', [], false))),
      ]);
      const { test } = await run(createActor(), [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ]),
        entry(union, [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      expect(test.isFailed()).toBe(true);
    });

    it('fails when the entries share no variable', async() => {
      const source = wrap(new TripleSource('s', [], true));
      const { test } = await run(createActor(), [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ]),
        entry(pattern(v('c'), name, v('n'), source), [], [ 'c', 'n' ], { cardinality: 10 }),
      ]);
      expect(test.getFailMessage()).toContain('at least one common variable');
    });

    it('charges one request per block rather than per binding', async() => {
      const source = wrap(new TripleSource('s', [], true));
      const { test } = await run(createActor(4), [
        entry(pattern(v('a'), knows, v('b')), [], [ 'a', 'b' ], { cardinality: 10, requestTime: 1 }),
        entry(pattern(v('b'), name, v('n'), source), [], [ 'b', 'n' ], { cardinality: 100, requestTime: 5 }),
      ]);
      // 1 for the first entry, 3 blocks of 4 bindings at 5 each into the other.
      expect(test.getOrThrow()).toEqual({
        iterations: 10 + 10,
        persistedItems: 4,
        blockingItems: 4,
        requestTime: 1 + 3 * 5,
      });
    });

    it('charges one request per binding for branches that can not take a block', async() => {
      const union = AF.createUnion([
        pattern(v('b'), name, v('n'), wrap(new TripleSource('s0', [], true))),
        pattern(v('b'), name, v('n'), wrap(new TripleSource('s1', [], false))),
      ]);
      const { test } = await run(createActor(5), [
        entry(pattern(v('a'), knows, v('b')), [], [ 'a', 'b' ], { cardinality: 10 }),
        entry(union, [], [ 'b', 'n' ], { cardinality: 100, requestTime: 4 }),
      ]);
      // Half the union is bound in 2 blocks, the other half once per binding: (2 + 10) / 2 requests.
      expect(test.getOrThrow().requestTime).toBe(6 * 4);
    });

    it('falls back on join selectivity when no variable is shared', async() => {
      const source = wrap(new TripleSource('s', [], true));
      const { test } = await run(createActor(), [
        entry(pattern(v('a'), knows, v('b')), [], [ 'a', 'b' ], { cardinality: 10, undef: true }),
        entry(pattern(v('c'), name, v('n'), source), [], [ 'c', 'n' ], { cardinality: 20, undef: true }),
      ]);
      // 10 * 20 * selectivity 0.5 * modifier 0.1.
      expect(test.getOrThrow().iterations).toBe(10 + 10);
    });
  });

  describe('run', () => {
    it('binds blocks into one shared source, like bind-source', async() => {
      const raw = new TripleSource('s', [
        [ iri('y'), name, DF.literal('Y') ],
        [ iri('z'), name, DF.literal('Z') ],
        [ iri('y'), iri('age'), DF.literal('3') ],
      ], true);
      const source = wrap(raw);
      const actor = createActor(2);
      const { action } = await run(actor, [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ], [ 'w', 'z' ], [ 'v', 'q' ]), [ 'a', 'b' ]),
        entry(pattern(v('b'), name, v('n'), source), [], [ 'b', 'n' ], { cardinality: 10 }),
        entry(pattern(v('b'), iri('age'), v('g'), source), [], [ 'b', 'g' ], { cardinality: 10 }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([ 'a=x b=y g=3 n=Y' ]);
      // Three bindings in blocks of two: two requests, each for the bundled join of both patterns.
      expect(raw.blockCalls.map(block => block.length)).toEqual([ 2, 1 ]);
      expect(mediatorJoin.mediate).not.toHaveBeenCalled();
      await expect(output.metadata()).resolves.toMatchObject({
        variables: expect.arrayContaining([{ variable: v('n'), canBeUndef: false }]),
      });
    });

    it('binds each block into every branch of a union', async() => {
      const s0 = new TripleSource('s0', [[ iri('y'), name, DF.literal('Y0') ]], true);
      const s1 = new TripleSource('s1', [
        [ iri('y'), name, DF.literal('Y1') ],
        [ iri('z'), name, DF.literal('Z1') ],
      ], true);
      const actor = createActor(16);
      const { action } = await run(actor, [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ], [ 'w', 'z' ]), [ 'a', 'b' ]),
        entry(AF.createUnion([
          pattern(v('b'), name, v('n'), wrap(s0)),
          pattern(v('b'), name, v('n'), wrap(s1)),
        ]), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([
        'a=w b=z n=Z1',
        'a=x b=y n=Y0',
        'a=x b=y n=Y1',
      ]);
      expect(s0.blockCalls).toHaveLength(1);
      expect(s1.blockCalls).toHaveLength(1);
    });

    it('binds one binding at a time into branches that can not take a block', async() => {
      const s0 = new TripleSource('s0', [[ iri('y'), name, DF.literal('Y0') ]], true);
      const s1 = new TripleSource('s1', [[ iri('z'), name, DF.literal('Z1') ]], false);
      const actor = createActor(16);
      const { action } = await run(actor, [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ], [ 'w', 'z' ]), [ 'a', 'b' ]),
        entry(AF.createUnion([
          pattern(v('b'), name, v('n'), wrap(s0)),
          pattern(v('b'), name, v('n'), { source: <any> s1, context: new ActionContext() }),
        ]), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([ 'a=w b=z n=Z1', 'a=x b=y n=Y0' ]);
      expect(s0.blockCalls).toHaveLength(1);
      // The bound subject is substituted into the pattern for each binding.
      expect(s1.singleCalls.map(operation => (<Algebra.Pattern> operation).subject.value)).toEqual([ 'y', 'z' ]);
    });

    it('binds bindings holding blank nodes one at a time, even into sources that take blocks', async() => {
      const blank = DF.blankNode('b0');
      const raw = new TripleSource('s', [
        [ blank, name, DF.literal('Blank') ],
        [ iri('y'), name, DF.literal('Y') ],
      ], true);
      const actor = createActor(16);
      const { action } = await run(actor, [
        entry(pattern(v('a'), knows, v('b')), [
          { a: iri('x'), b: blank },
          { a: iri('x'), b: iri('y') },
          { a: DF.quad(blank, knows, iri('y')), b: iri('missing') },
        ], [ 'a', 'b' ]),
        entry(AF.createUnion([ pattern(v('b'), name, v('n'), wrap(raw)) ]), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([ 'a=x b=b0 n=Blank', 'a=x b=y n=Y' ]);
      expect(raw.blockCalls.map(block => block.length)).toEqual([ 1 ]);
      expect(raw.singleCalls).toHaveLength(2);
    });

    it('drops per-binding results that conflict with the binding', async() => {
      const raw = new TripleSource('s', [], false);
      // A source that ignores the bound value and answers with another one for the same variable.
      raw.queryBindings = () => new ArrayIterator([ BF.fromRecord({ b: iri('other'), n: DF.literal('N') }) ]);
      const actor = createActor(16);
      const { action } = await run(actor, [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ]),
        entry(AF.createUnion([
          pattern(v('b'), name, v('n'), wrap(raw)),
          pattern(v('b'), name, v('n'), wrap(new TripleSource('t', [], true))),
        ]), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      await expect(output.bindingsStream.toArray()).resolves.toEqual([]);
    });

    it('skips the block request when every binding holds a blank node', async() => {
      const raw = new TripleSource('s', [[ DF.blankNode('b0'), name, DF.literal('Blank') ]], true);
      const actor = createActor(16);
      const { action } = await run(actor, [
        entry(pattern(v('a'), knows, v('b')), [{ a: iri('x'), b: DF.blankNode('b0') }], [ 'a', 'b' ]),
        entry(pattern(v('b'), name, v('n'), wrap(raw)), [], [ 'b', 'n' ], { cardinality: 10 }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([ 'a=x b=b0 n=Blank' ]);
      expect(raw.blockCalls).toHaveLength(0);
    });

    it('binds the best-connected entry and hands the rest back to the join bus', async() => {
      const s0 = new TripleSource('s0', [[ iri('y'), name, DF.literal('Y') ]], true);
      const s1 = new TripleSource('s1', [[ iri('Y-city'), iri('in'), iri('BE') ]], true);
      const actor = createActor(16);
      const first = entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ]);
      const named = entry(pattern(v('b'), name, v('n'), wrap(s0)), [], [ 'b', 'n' ], { cardinality: 10 });
      const located = entry(
        pattern(v('c'), iri('in'), v('k'), wrap(s1)),
        [{ c: iri('Y-city'), k: iri('BE') }],
        [ 'c', 'k' ],
        { cardinality: 5 },
      );
      // Connected to the first entry, but without a source to bind into.
      const aged = entry(pattern(v('a'), iri('age'), v('g')), [{ a: iri('x'), g: DF.literal('3') }], [ 'a', 'g' ], {
        cardinality: 20,
      });
      const { action, test } = await run(actor, [ first, named, located, aged ]);
      expect(test.isPassed()).toBe(true);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([ 'a=x b=y c=Y-city g=3 k=BE n=Y' ]);
      const { entries } = mediatorJoin.mediate.mock.calls[0][0];
      expect(entries).toHaveLength(3);
      expect(entries[0].operationModified).toBe(true);
      expect(s0.blockCalls).toHaveLength(1);
    });

    it('does not bind into an entry whose operation was already modified', async() => {
      const raw = new TripleSource('s', [], true);
      const { test } = await run(createActor(), [
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ], { modified: true }),
        entry(pattern(v('b'), name, v('n'), wrap(raw)), [], [ 'b', 'n' ], { cardinality: 10, modified: true }),
        entry(pattern(v('n'), name, v('m'), wrap(new TripleSource('t', [], true))), [], [ 'n', 'm' ], {
          cardinality: 10,
        }),
      ]);
      expect(test.getFailMessage()).toContain('found no entry connected to the first one');
    });

    it('prefers modified entries as the one to bind from', async() => {
      const raw = new TripleSource('s', [[ iri('y'), name, DF.literal('Y') ]], true);
      const actor = createActor(16);
      const { action } = await run(actor, [
        entry(pattern(v('b'), name, v('n'), wrap(raw)), [], [ 'b', 'n' ], { cardinality: 1 }),
        entry(pattern(v('a'), knows, v('b')), people([ 'x', 'y' ]), [ 'a', 'b' ], { cardinality: 50, modified: true }),
      ]);
      const output = await actor.run(action, (await actor.test(action)).getSideData());
      expect(records(await output.bindingsStream.toArray())).toEqual([ 'a=x b=y n=Y' ]);
    });
  });

  describe('branchesOf', () => {
    const source = wrap(new TripleSource('s', [], true));

    it('splits nested unions of annotated operations', () => {
      const leaf = pattern(v('s'), v('p'), v('o'), source);
      expect(ActorRdfJoinMultiBindSources.branchesOf(AF.createUnion([ leaf, AF.createUnion([ leaf ]) ])))
        .toHaveLength(2);
    });

    it('rejects unions with an unannotated branch, empty unions, and other operations', () => {
      expect(ActorRdfJoinMultiBindSources.branchesOf(AF.createUnion([
        pattern(v('s'), v('p'), v('o'), source),
        pattern(v('s'), v('p'), v('o')),
      ]))).toBeUndefined();
      expect(ActorRdfJoinMultiBindSources.branchesOf(AF.createUnion([]))).toBeUndefined();
      expect(ActorRdfJoinMultiBindSources.branchesOf(AF.createJoin([]))).toBeUndefined();
    });
  });

  it('is an RDF join actor', () => {
    expect(createActor()).toBeInstanceOf(ActorRdfJoin);
  });
});
