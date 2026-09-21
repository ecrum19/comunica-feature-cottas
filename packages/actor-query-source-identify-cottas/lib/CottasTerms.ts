import type { ComunicaDataFactory } from '@comunica/types';
import type * as RDF from '@rdfjs/types';
import { Parser, Writer } from 'n3';

const TERM_PREFIX = '<urn:comunica:cottas:subject> <urn:comunica:cottas:predicate> ';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/**
 * Translates between RDF/JS terms and the N-Triples strings a COTTAS file stores.
 *
 * Kept apart from the DuckDB layer because the tricky part here is RDF, not SQL: one term has
 * several legal spellings, and a constant only matches if the comparison covers all of them.
 */
export class CottasTermCodec {
  private readonly dataFactory: ComunicaDataFactory;
  private readonly writer = new Writer({ format: 'N-Triples' });
  private readonly source: string;

  public constructor(dataFactory: ComunicaDataFactory, source: string) {
    this.dataFactory = dataFactory;
    this.source = source;
  }

  /** Serialize one term the way N3 writes it inside an N-Triples document. */
  public serialize(term: RDF.Term): string {
    /* istanbul ignore if -- callers handle these two non-value terms before serialization. */
    if (term.termType === 'Variable' || term.termType === 'DefaultGraph') {
      throw new Error(`RDF term '${term.termType}' cannot be serialized as a COTTAS value.`);
    }
    const line = this.writer.quadToString(
      this.dataFactory.namedNode('urn:comunica:cottas:subject'),
      this.dataFactory.namedNode('urn:comunica:cottas:predicate'),
      <RDF.Quad_Object> term,
    );
    /* istanbul ignore if -- N3's N-Triples writer guarantees this framing. */
    if (!line.startsWith(TERM_PREFIX) || !line.endsWith(' .\n')) {
      throw new Error(`Unable to serialize RDF term '${term.value}' for COTTAS.`);
    }
    return line.slice(TERM_PREFIX.length, -3);
  }

  /**
   * List every COTTAS encoding that denotes `term`.
   *
   * One RDF term has more than one legal encoding: N3 escapes astral characters that files usually
   * store raw, and RDF 1.1 makes a simple literal the same term as an `xsd:string`-typed one.
   * Comparing against a single serialization would silently drop solutions from files that use
   * another spelling.
   */
  public encodings(term: RDF.Term): string[] {
    const serialized = this.serialize(term);
    const unescaped = unescapeUnicode(serialized);
    const encodings = unescaped === serialized ? [ serialized ] : [ serialized, unescaped ];
    if (term.termType === 'Literal' && !term.language && term.datatype.value === XSD_STRING) {
      return [ ...encodings, ...encodings.map(encoding => `${encoding}^^<${XSD_STRING}>`) ];
    }
    return encodings;
  }

  /** Build a condition matching any encoding of `term`, pushed down into DuckDB. */
  public condition(column: string, term: RDF.Term, addValue: (value: string) => string): string {
    const encodings = this.encodings(term);
    const language = term.termType === 'Literal' ? term.language : '';
    // The guard also rules out a base direction such as `@en--ltr`, where the tag is not the
    // final segment and slicing it off by length would cut into the direction instead.
    if (language && encodings.every(encoding => encoding.toLowerCase().endsWith(`@${language.toLowerCase()}`))) {
      // Language tags compare case-insensitively. The prefix pins the lexical form exactly,
      // so only the tag is left free to differ in case.
      const clauses = encodings.map((encoding) => {
        const lexical = addValue(encoding.slice(0, encoding.length - language.length));
        const folded = addValue(encoding.toLowerCase());
        return `(starts_with(${column}, ${lexical}) AND lower(${column}) = ${folded})`;
      });
      return `(${clauses.join(' OR ')})`;
    }
    return encodings.length === 1 ?
        `${column} = ${addValue(encodings[0])}` :
        `${column} IN (${encodings.map(addValue).join(', ')})`;
  }

  /** Parse complete N-Quads lines, expecting exactly `expected` statements. */
  public parseStatements(lines: string, expected: number): RDF.BaseQuad[] {
    let quads: RDF.BaseQuad[];
    try {
      quads = <RDF.BaseQuad[]> <unknown> new Parser({
        format: 'N-Quads',
        blankNodePrefix: '_:',
        factory: <any> this.dataFactory,
      }).parse(lines);
    } catch (error: unknown) {
      throw new Error(`Invalid RDF term encoding in COTTAS file '${this.source}': ${errorMessage(error)}`);
    }
    /* istanbul ignore if -- the N-Quads parser emits one quad per validated line. */
    if (quads.length !== expected) {
      throw new Error(
        `Invalid RDF term encoding in COTTAS file '${this.source}': expected ${expected} RDF statements but decoded ${
          quads.length}`,
      );
    }
    return quads;
  }

  /**
   * Decode a batch of stored term strings.
   *
   * Terms repeat heavily across join results, so unique values are parsed once in a single pass
   * rather than per row.
   */
  public parseTerms(values: string[]): Map<string, RDF.Term> {
    const unique = [ ...new Set(values) ];
    const quads = this.parseStatements(unique.map(value => `${TERM_PREFIX}${value} .`).join('\n'), unique.length);
    return new Map(unique.map((value, index): [string, RDF.Term] => [ value, quads[index].object ]));
  }
}

/**
 * Decode the `\uXXXX` and `\UXXXXXXXX` escapes N3 writes for astral and control characters.
 *
 * Escapes are consumed left to right, so an escaped backslash is copied verbatim and never
 * mistaken for the start of a character escape.
 */
function unescapeUnicode(value: string): string {
  return value.replaceAll(
    /\\(?:U([\da-f]{8})|u([\da-f]{4})|(.))/gisu,
    (match, long: string | undefined, short: string | undefined) =>
      (long ?? short) === undefined ? match : String.fromCodePoint(Number.parseInt(long ?? short!, 16)),
  );
}

export function errorMessage(error: unknown): string {
  /* istanbul ignore else -- Node.js and DuckDB reject with Error instances. */
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
