import type { ComunicaDataFactory } from '@comunica/types';
import type * as RDF from '@rdfjs/types';

/** Cardinality information returned by a COTTAS pattern scan. */
export interface ICottasCountResult {
  totalCount: number;
  hasExactCount: boolean;
}

/** A bounded page of COTTAS bindings and its cardinality information. */
export interface ICottasBindingsResult extends ICottasCountResult {
  bindings: RDF.Bindings[];
}

/**
 * The narrow adapter contract between Comunica and the selected COTTAS runtime.
 *
 * Phase 0 of COTTAS_IMPLEMENTATION_PLAN.md must implement this interface after
 * validating the physical COTTAS schema and RDF term encoding.
 */
export interface CottasDocument {
  readonly closed?: boolean;

  countPattern: (
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph?: RDF.Term,
  ) => Promise<ICottasCountResult>;

  searchBindings: (
    bindingsFactory: RDF.BindingsFactory,
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph: RDF.Term | undefined,
    options: { offset: number; limit: number },
  ) => Promise<ICottasBindingsResult>;

  close: () => Promise<void>;
}

/**
 * Open a COTTAS document.
 *
 * This intentionally remains an integration seam until the runtime spike has
 * established the COTTAS-on-Parquet schema and a supported DuckDB version.
 */
export async function openCottasDocument(
  _path: string,
  _dataFactory: ComunicaDataFactory,
): Promise<CottasDocument> {
  throw new Error(
    'The COTTAS runtime adapter is not implemented yet; complete Phase 0 of COTTAS_IMPLEMENTATION_PLAN.md first.',
  );
}
