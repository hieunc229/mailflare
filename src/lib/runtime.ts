/**
 * Where the app is running. On Cloudflare Workers the bindings come from
 * cloudflare:workers; the self-hosted Node server builds an equivalent env object and
 * publishes it on globalThis before Next starts, so route handlers reach it
 * the same way.
 */
declare global {
	var __mailflareNodeEnv: CloudflareEnv | undefined;
}

export function getNodeEnv(): CloudflareEnv | undefined {
	return globalThis.__mailflareNodeEnv;
}

export function isNodeRuntime(env?: Pick<CloudflareEnv, "MAILFLARE_RUNTIME">): boolean {
	return (env ?? getNodeEnv())?.MAILFLARE_RUNTIME === "node";
}

/**
 * Vercel (docs/vercel.md). Without an env it reads the process: `next.config.ts` inlines the value into a Vercel
 * build, and no env object is published on `globalThis` there.
 */
export function isVercelRuntime(env?: Pick<CloudflareEnv, "MAILFLARE_RUNTIME">): boolean {
	return (env ? env.MAILFLARE_RUNTIME : process.env.MAILFLARE_RUNTIME) === "vercel";
}

/** Anywhere but a Cloudflare Worker: no Email Worker, no Workers-set request URL or headers. */
export function isOffWorkers(env?: Pick<CloudflareEnv, "MAILFLARE_RUNTIME">): boolean {
	return isNodeRuntime(env) || isVercelRuntime(env);
}

/** True when the app can talk to the Cloudflare API to manage zones and routing. */
export function hasCloudflareCredentials(env: Pick<CloudflareEnv, "CF_TOKEN" | "CF_API_KEY" | "CF_EMAIL">): boolean {
	return !!env.CF_TOKEN?.trim() || (!!env.CF_API_KEY?.trim() && !!env.CF_EMAIL?.trim());
}
