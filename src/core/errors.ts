export type FragErrorCode =
  | "CONFIGURATION_ERROR"
  | "UNKNOWN_COLLECTION"
  | "COLLECTION_NOT_ALLOWED"
  | "COLLECTION_UNREACHABLE"
  | "DIMENSION_MISMATCH"
  | "CONCURRENT_MODIFICATION"
  | "SOURCE_KEY_CONFLICT"
  | "CHUNK_TOO_LONG"
  | "EMBEDDER_LENGTH_ERROR"
  | "INVALID_INGESTION_MODE"
  | "INVALID_METADATA"
  | "MIRROR_CONFIGURATION_CYCLE";

export class FragError extends Error {
  readonly code: FragErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: FragErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ConfigurationError extends FragError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super("CONFIGURATION_ERROR", message, details, options);
  }
}

export class UnknownCollectionError extends FragError {
  constructor(collection: string) {
    super("UNKNOWN_COLLECTION", `Unknown collection: ${collection}`, { collection });
  }
}

export class CollectionNotAllowedError extends FragError {
  constructor(collection: string) {
    super("COLLECTION_NOT_ALLOWED", "Collection is not available in this process", {
      collection,
    });
  }
}

export class CollectionUnreachableError extends FragError {
  constructor(collection: string, reason: string) {
    super(
      "COLLECTION_UNREACHABLE",
      `Collection ${collection} is unreachable: ${reason}`,
      { collection, reason },
    );
  }
}

export class DimensionMismatchError extends FragError {
  constructor(collection: string, configured: number, stored: readonly number[]) {
    super(
      "DIMENSION_MISMATCH",
      `Collection ${collection} is configured for ${configured} dimensions but contains ${stored.join(
        ", ",
      )}-dimensional sources; create a new collection for a dimension change`,
      { collection, configured, stored: [...stored] },
    );
  }
}

export class ConcurrentModificationError extends FragError {
  constructor(collection: string, sourceKey: string) {
    super(
      "CONCURRENT_MODIFICATION",
      `Source ${collection}/${sourceKey} changed while the operation was being prepared`,
      { collection, sourceKey },
    );
  }
}

export class SourceKeyConflictError extends FragError {
  constructor(
    collection: string,
    sourceKey: string,
    existingOrigin: Readonly<{ collection: string | null; sourceKey: string | null }>,
  ) {
    super(
      "SOURCE_KEY_CONFLICT",
      `Target source key ${collection}/${sourceKey} belongs to a different origin`,
      { collection, sourceKey, existingOrigin },
    );
  }
}

export class ChunkTooLongError extends FragError {
  constructor(input: {
    sourceKey: string;
    chunkIndex: number;
    count: number;
    limit: number;
    exact: boolean;
  }) {
    super(
      "CHUNK_TOO_LONG",
      `Chunk ${input.chunkIndex} of ${input.sourceKey} is too long (${input.count} tokens, limit ${input.limit})`,
      input,
    );
  }
}

export class EmbedderLengthError extends FragError {
  constructor(sourceKey: string, chunkIndex: number, options?: ErrorOptions) {
    super(
      "EMBEDDER_LENGTH_ERROR",
      `Embedder rejected chunk ${chunkIndex} of ${sourceKey} for length`,
      { sourceKey, chunkIndex },
      options,
    );
  }
}

export class InvalidIngestionModeError extends FragError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("INVALID_INGESTION_MODE", message, details);
  }
}

export class InvalidMetadataError extends FragError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("INVALID_METADATA", message, details);
  }
}

export class MirrorConfigurationCycleError extends FragError {
  constructor(path: readonly string[]) {
    super(
      "MIRROR_CONFIGURATION_CYCLE",
      `Mirror configuration contains a cycle: ${path.join(" -> ")}`,
      { path: [...path] },
    );
  }
}
