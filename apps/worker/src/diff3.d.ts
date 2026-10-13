// `diff3` (the three-way merge isomorphic-git itself uses) ships no types.
declare module "diff3" {
	type Chunk = { ok?: string[]; conflict?: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number } };
	export default function diff3Merge(a: string[], o: string[], b: string[]): Chunk[];
}
