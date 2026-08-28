import type { Queryable, StateStore, Tx } from "../store.js";
import type { Operation, StateReceipt } from "../types.js";

type ReceiptRow = Record<string, unknown> & {
  source_collection: string;
  source_key: string;
  target_collection: string;
  target_source_key: string;
  operation: Operation;
  ref: string;
  created_at: Date | string;
};

function receipt(row: ReceiptRow): StateReceipt {
  return {
    sourceCollection: row.source_collection,
    sourceKey: row.source_key,
    targetCollection: row.target_collection,
    targetSourceKey: row.target_source_key,
    operation: row.operation,
    ref: row.ref,
    createdAt: new Date(row.created_at),
  };
}

export class PostgresStateStore implements StateStore {
  readonly #database: Queryable;

  constructor(database: Queryable) {
    this.#database = database;
  }

  async replaceReceipt(
    tx: Tx,
    operation: Operation,
    source: string,
    sourceKey: string,
    target: string,
    targetSourceKey: string,
    ref: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO _frag_state (
         source_collection, source_key, target_collection, target_source_key,
         operation, ref
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (target_collection, target_source_key) DO UPDATE SET
         source_collection = EXCLUDED.source_collection,
         source_key = EXCLUDED.source_key,
         operation = EXCLUDED.operation,
         ref = EXCLUDED.ref,
         created_at = now()`,
      [source, sourceKey, target, targetSourceKey, operation, ref],
    );
  }

  async hasOperation(
    operation: Operation,
    source: string,
    target: string,
    ref: string,
    queryable: Queryable = this.#database,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM _frag_state
       WHERE operation = $1 AND source_collection = $2
         AND target_collection = $3 AND ref = $4`,
      [operation, source, target, ref],
    );
    return result.rows.length > 0;
  }

  async getTargetReceipt(
    target: string,
    targetSourceKey: string,
    queryable: Queryable = this.#database,
  ): Promise<StateReceipt | null> {
    const result = await queryable.query<ReceiptRow>(
      `SELECT source_collection, source_key, target_collection, target_source_key,
              operation, ref, created_at
       FROM _frag_state
       WHERE target_collection = $1 AND target_source_key = $2`,
      [target, targetSourceKey],
    );
    return result.rows[0] === undefined ? null : receipt(result.rows[0]);
  }

  async deleteTargetReceipt(tx: Tx, target: string, targetSourceKey: string): Promise<void> {
    await tx.query(
      "DELETE FROM _frag_state WHERE target_collection = $1 AND target_source_key = $2",
      [target, targetSourceKey],
    );
  }
}
