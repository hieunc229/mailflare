export const UPDATE_SOURCE_REPOSITORY = "hieunc229/mailflare";

/**
 * A fine-grained token scoped to this installation gets 404 for the public upstream
 * repository, even though the same URL works without credentials.
 */
export function shouldRetryGitHubAnonymously(path: string, status: number): boolean {
	return status === 404 && path.startsWith(`/repos/${UPDATE_SOURCE_REPOSITORY}`);
}

/**
 * How many leading upstream commits are absent from the installation.
 * Null when the shared history is outside the commits that were read.
 * GitHub's compare API only works across a fork and its parent, and this
 * installation is a separate private repository.
 */
export function commitsBehind(upstreamShas: readonly string[], installationShas: ReadonlySet<string>): number | null {
	let behind = 0;
	for (const sha of upstreamShas) {
		if (installationShas.has(sha)) return behind;
		behind += 1;
	}
	return null;
}
