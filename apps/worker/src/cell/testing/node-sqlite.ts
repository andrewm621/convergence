import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlRow } from "../sql";

/**
 * Node's built-in SQLite as a `SqlDb`. Same engine family and dialect as Durable Object storage,
 * so the store's SQL runs unchanged; used for fast tests that need no Workers runtime.
 */
export function nodeSqlite(): SqlDb & { close(): void; db: DatabaseSync } {
	const db = new DatabaseSync(":memory:");
	let depth = 0;
	return {
		db,
		close: () => db.close(),
		all: <T extends SqlRow>(query: string, ...bindings: unknown[]) => db.prepare(query).all(...(bindings as never[])) as unknown as T[],
		transaction<T>(fn: () => T): T {
			if (depth > 0) return fn();
			db.exec("BEGIN IMMEDIATE");
			depth++;
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			} finally {
				depth--;
			}
		},
	};
}
