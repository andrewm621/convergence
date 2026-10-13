// The only SQL surface the cell needs. The Durable Object's SQLite storage satisfies it directly,
// and tests can satisfy it with any other SQLite (see testing/node-sqlite.ts), so the store logic
// is the same code on both.

export type SqlRow = Record<string, unknown>;

export interface SqlDb {
	/** Run one statement and return its rows (an empty array for statements that return none). */
	all<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): T[];
	/** Run `fn` atomically: every write inside lands, or none does. `fn` must be synchronous. */
	transaction<T>(fn: () => T): T;
}

/** Durable Object storage as a `SqlDb`. `transactionSync` rolls back if `fn` throws. */
export function durableObjectSql(storage: DurableObjectStorage): SqlDb {
	return {
		all: <T extends SqlRow>(query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings).toArray() as unknown as T[],
		transaction: (fn) => storage.transactionSync(fn),
	};
}
