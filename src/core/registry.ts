import { CollectionNotAllowedError, CollectionUnreachableError, UnknownCollectionError } from "./errors.js";
import type { IngestService } from "./ingest.js";
import type { CollectionStatus, SearchService } from "./search.js";
import type { CollectionConfig, IngestInput, SearchOptions, SearchResponse, WriteResult } from "./types.js";

export interface CollectionRuntime {
  readonly config: CollectionConfig;
  readonly search: SearchService;
  readonly ingest: IngestService;
}

export interface UnreachableCollection {
  readonly config: CollectionConfig;
  readonly reason: string;
}

export interface CollectionListing {
  readonly name: string;
  readonly description: string;
  readonly unreachable?: true;
  readonly reason?: string;
}

export class FragRegistry {
  readonly #collections: ReadonlyMap<string, CollectionRuntime>;
  readonly #unreachable: ReadonlyMap<string, UnreachableCollection>;
  readonly #allowed: ReadonlySet<string> | null;

  constructor(
    collections: Iterable<CollectionRuntime>,
    options: {
      readonly allowedCollections?: Iterable<string>;
      readonly unreachable?: Iterable<UnreachableCollection>;
    } = {},
  ) {
    const byName = new Map<string, CollectionRuntime>();
    for (const runtime of collections) {
      if (byName.has(runtime.config.name)) {
        throw new TypeError(`Duplicate collection runtime: ${runtime.config.name}`);
      }
      byName.set(runtime.config.name, runtime);
    }
    const unreachableByName = new Map<string, UnreachableCollection>();
    for (const entry of options.unreachable ?? []) {
      if (byName.has(entry.config.name) || unreachableByName.has(entry.config.name)) {
        throw new TypeError(`Duplicate collection runtime: ${entry.config.name}`);
      }
      unreachableByName.set(entry.config.name, entry);
    }
    this.#collections = byName;
    this.#unreachable = unreachableByName;
    this.#allowed =
      options.allowedCollections === undefined ? null : new Set(options.allowedCollections);
  }

  listCollections(): CollectionListing[] {
    const allowed = (name: string): boolean => this.#allowed === null || this.#allowed.has(name);
    const healthy = [...this.#collections.values()]
      .filter(({ config }) => allowed(config.name))
      .map(({ config }) => ({ name: config.name, description: config.description }));
    const broken = [...this.#unreachable.values()]
      .filter(({ config }) => allowed(config.name))
      .map(({ config, reason }) => ({
        name: config.name,
        description: config.description,
        unreachable: true as const,
        reason,
      }));
    return [...healthy, ...broken].sort((left, right) => left.name.localeCompare(right.name));
  }

  async search(
    collection: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    return this.#runtime(collection).search.search(query, options);
  }

  async ingest(input: IngestInput): Promise<WriteResult> {
    return this.#runtime(input.collection).ingest.ingest(input);
  }

  async inspectCollections(): Promise<CollectionStatus[]> {
    const visible = [...this.#collections.values()].filter(
      ({ config }) => this.#allowed === null || this.#allowed.has(config.name),
    );
    return Promise.all(visible.map(({ search }) => search.inspectStatus()));
  }

  #runtime(collection: string): CollectionRuntime {
    if (this.#allowed !== null && !this.#allowed.has(collection)) {
      throw new CollectionNotAllowedError(collection);
    }
    const unreachable = this.#unreachable.get(collection);
    if (unreachable !== undefined) throw new CollectionUnreachableError(collection, unreachable.reason);
    const runtime = this.#collections.get(collection);
    if (runtime === undefined) throw new UnknownCollectionError(collection);
    return runtime;
  }
}
