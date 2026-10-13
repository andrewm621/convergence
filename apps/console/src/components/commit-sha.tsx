import { ExternalLink } from "lucide-react";
import { shortHash } from "@/lib/format";
import { REPO_URL, SCENARIO_META } from "@/features/scenario-meta";
import { useConsole } from "@/state/console-context";

const ZERO_SHA = /^0+$/;

/** True for the all-zero sha, which the build replay uses for "this is not in git". */
export function isNotInGit(sha: string | null | undefined): boolean {
	return Boolean(sha) && ZERO_SHA.test(sha as string);
}

/**
 * A commit sha in short form. In the replay of our own build the shas are real: they link to the commit on
 * GitHub, and the all-zero sha reads "not in git". In every other scenario the shas are scripted, so they
 * are plain text and never a link.
 */
export function CommitSha({ sha, length = 7, className }: { sha: string | null | undefined; length?: number; className?: string }) {
	const { client } = useConsole();
	if (!sha) return <span className={className}>{shortHash(sha, length)}</span>;
	if (!SCENARIO_META[client.scenario].realHistory) return <span className={className}>{shortHash(sha, length)}</span>;
	if (isNotInGit(sha)) {
		return (
			<span className={className} title="This is not a commit: it has no place in git." data-testid="not-in-git">
				not in git
			</span>
		);
	}
	return (
		<a
			href={`${REPO_URL}/commit/${sha}`}
			target="_blank"
			rel="noreferrer"
			className={`inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-primary ${className ?? ""}`}
			title={`Open ${sha} on GitHub`}
			data-testid="commit-link"
		>
			{shortHash(sha, length)}
			<ExternalLink className="size-3" aria-hidden />
		</a>
	);
}
