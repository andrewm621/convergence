/** What the public read-only view shows for a cell the Worker does not list as public: a plain message and the way to the replay. */
export function NotPublic({ cell }: { cell: string }) {
	return (
		<main data-testid="not-public" className="grid h-full place-items-center bg-background px-6">
			<div className="max-w-md space-y-3 text-sm">
				<h1 className="text-base font-semibold">This cell is not available in the public view</h1>
				<p className="text-muted-foreground">
					<span className="font-mono">{cell}</span> is not one of the live cells the maintainer has opened for public reading. Live cells otherwise need the maintainer&apos;s token.
				</p>
				<p>
					<a className="underline underline-offset-4" href="?mock=1">
						Open the replay instead
					</a>{" "}
					<span className="text-muted-foreground">(no account needed; it runs in your browser).</span>
				</p>
			</div>
		</main>
	);
}
