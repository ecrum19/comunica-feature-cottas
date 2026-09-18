import type * as RDF from '@rdfjs/types';
import type {
  CottasDocument,
  ICottasBindingsResult,
  ICottasCountResult,
  ICottasGraphOptions,
} from '../lib/CottasDocument';

export class MockedCottasDocument implements CottasDocument {
  public closed = false;
  public readonly hasGraphColumn: boolean;

  private readonly triples: RDF.BaseQuad[];
  private readonly hasExactCount: boolean;
  private error: Error | undefined;

  public constructor(triples: RDF.BaseQuad[], hasExactCount = true) {
    this.triples = triples;
    this.hasExactCount = hasExactCount;
    this.hasGraphColumn = triples.some(triple => triple.graph.termType !== 'DefaultGraph');
  }

  protected static tripleMatches(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    triple: RDF.BaseQuad,
    graph?: RDF.Term,
    unionDefaultGraph = false,
  ): boolean {
    const values = new Map<string, RDF.Term>();
    const pairs: [RDF.Term, RDF.Term][] = [
      [ subject, triple.subject ],
      [ predicate, triple.predicate ],
      [ object, triple.object ],
    ];
    if (!graph || graph.termType === 'DefaultGraph') {
      if (!unionDefaultGraph && triple.graph.termType !== 'DefaultGraph') {
        return false;
      }
    } else if (graph.termType === 'Variable') {
      if (!unionDefaultGraph && triple.graph.termType === 'DefaultGraph') {
        return false;
      }
      pairs.push([ graph, triple.graph ]);
    } else if (!graph.equals(triple.graph)) {
      return false;
    }
    for (const [ patternTerm, value ] of pairs) {
      if (patternTerm.termType === 'Variable') {
        const existing = values.get(patternTerm.value);
        if (existing && !existing.equals(value)) {
          return false;
        }
        values.set(patternTerm.value, value);
      } else if (!patternTerm.equals(value)) {
        return false;
      }
    }
    return true;
  }

  public async searchBindings(
    bindingsFactory: RDF.BindingsFactory,
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term | undefined,
    options: ICottasGraphOptions & { offset: number; limit: number },
  ): Promise<ICottasBindingsResult> {
    if (this.error) {
      throw this.error;
    }
    const offset = options.offset || 0;
    const limit = Math.min(options.limit, this.triples.length);
    let i = 0;
    const bindings: RDF.Bindings[] = [];
    for (const triple of this.triples) {
      if (MockedCottasDocument.tripleMatches(
        subject,
        predicate,
        object,
        triple,
        graph,
        options.unionDefaultGraph,
      )) {
        if (i >= offset && i < offset + limit) {
          const entries: [RDF.Variable, RDF.Term][] = [];
          const addEntry = (variable: RDF.Variable, value: RDF.Term): void => {
            if (!entries.some(([ existing ]) => existing.equals(variable))) {
              entries.push([ variable, value ]);
            }
          };
          if (subject.termType === 'Variable') {
            addEntry(subject, triple.subject);
          }
          if (predicate.termType === 'Variable') {
            addEntry(predicate, triple.predicate);
          }
          if (object.termType === 'Variable') {
            addEntry(object, triple.object);
          }
          if (graph?.termType === 'Variable') {
            addEntry(graph, triple.graph);
          }
          bindings.push(bindingsFactory.bindings(entries));
        }
        i++;
      }
    }
    return { bindings };
  }

  public async countPattern(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph?: RDF.Term,
    options: ICottasGraphOptions = {},
  ): Promise<ICottasCountResult> {
    if (this.error) {
      throw this.error;
    }
    let i = 0;
    for (const triple of this.triples) {
      if (MockedCottasDocument.tripleMatches(
        subject,
        predicate,
        object,
        triple,
        graph,
        options.unionDefaultGraph,
      )) {
        i++;
      }
    }
    return { totalCount: i, hasExactCount: this.hasExactCount };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }

  public setError(error: Error): void {
    this.error = error;
  }
}
