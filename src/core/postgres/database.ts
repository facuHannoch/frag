import { Pool, type PoolConfig, type QueryResultRow } from "pg";

import type { QueryResult, Queryable, Transactional, Tx } from "../store.js";

export class PostgresDatabase implements Queryable, Transactional {
  readonly #pool: Pool;

  constructor(config: PoolConfig | string) {
    this.#pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.#pool.query<QueryResultRow>(text, [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const tx: Tx = {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<QueryResult<Row>> {
          const result = await client.query<QueryResultRow>(text, [...values]);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      } as Tx;
      const value = await fn(tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Transaction and rollback both failed");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
