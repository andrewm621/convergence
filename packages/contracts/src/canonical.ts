/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, arrays keep their order.
 * Everything Delta hashes (facets, snapshots, receipts, ledger lines) goes through this, so a
 * hash is a pure function of the value and never of key insertion order.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value, "$"));
}

/** Canonical JSON, indented for humans (git notes). Same bytes for the same value, every time. */
export function canonicalJsonPretty(value: unknown): string {
	return JSON.stringify(canonicalize(value, "$"), null, 2);
}

function canonicalize(value: unknown, path: string): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
			return value;
		case "object": {
			if (Array.isArray(value)) return value.map((item, i) => canonicalize(item, `${path}[${i}]`));
			// Dates, Maps, Sets, typed arrays and class instances have no stable JSON form; hashing them as {} would be silent.
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: non-plain object at ${path}`);
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(value as Record<string, unknown>).sort()) {
				const child = (value as Record<string, unknown>)[key];
				// undefined means "absent" in JSON; skipping it keeps optional fields hash-stable.
				if (child === undefined) continue;
				out[key] = canonicalize(child, `${path}.${key}`);
			}
			return out;
		}
		default:
			throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
	}
}
