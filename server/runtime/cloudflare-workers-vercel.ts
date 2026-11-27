// The Vercel build's stand-in for `cloudflare:workers` (see next.config.ts). There is no server entrypoint to
// publish an env before requests arrive, so it is assembled on first use; `next build` can import this module
// without any variables set.
import { getVercelEnv } from "./vercel-env";

export const env = new Proxy({} as CloudflareEnv, {
	get: (_target, property) => Reflect.get(getVercelEnv(), property),
});
