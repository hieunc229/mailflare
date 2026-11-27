/** The `ASSETS` fetcher on Vercel, where `public/` is served by the CDN and is not on the function's disk. */
export function openVercelAssets(appUrl: string): Fetcher {
	return {
		fetch(input: RequestInfo | URL) {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return fetch(new URL(`${url.pathname}${url.search}`, appUrl));
		},
	} as unknown as Fetcher;
}
