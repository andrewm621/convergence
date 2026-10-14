// Lets plain Node (>= 26, which strips TypeScript types natively) load this workspace's TypeScript sources,
// whose imports are extensionless (`./analysis`, bundler-style). Used by the reference adapter and the vector
// generator only; the runner itself needs nothing beyond Node. Usage: node --import ./ts-hooks.mjs <file.ts>
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			const relative = specifier.startsWith("./") || specifier.startsWith("../");
			if (!relative || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
			for (const suffix of [".ts", "/index.ts"]) {
				try {
					return nextResolve(specifier + suffix, context);
				} catch {
					// try the next suffix
				}
			}
			throw error;
		}
	},
});
