export const UPDATE_SOURCE_REPOSITORY = "hieunc229/mailflare";

/**
 * A fine-grained token scoped to this installation gets 404 for the public upstream
 * repository, even though the same URL works without credentials.
 */
export function shouldRetryGitHubAnonymously(path: string, status: number): boolean {
	return status === 404 && path.startsWith(`/repos/${UPDATE_SOURCE_REPOSITORY}`);
}
