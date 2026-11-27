import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "@/lib/cloudflare";
import { handleDavRequest } from "@/lib/dav/handler";
import { isVercelRuntime } from "@/lib/runtime";
import { serveFetch } from "./fetch-adapter";
import { davRequestTarget } from "./vercel-dav";

/**
 * CalDAV/CardDAV on Vercel. PROPFIND and REPORT cannot be App Router route handlers, and there is no server in
 * front of Next, so next.config.ts rewrites the DAV paths to a Pages Router route that exports this handler.
 * scripts/build-vercel.mjs writes that route for the Vercel build only: a `pages` directory in the source tree
 * would change Next's navigation types and add a second router to the Workers and self-hosted builds.
 */
export default async function handler(request: NextApiRequest, response: NextApiResponse) {
	if (!isVercelRuntime()) {
		response.status(404).end("Not found");
		return;
	}
	request.url = davRequestTarget(request.url ?? "/");
	await serveFetch(handleDavRequest, request, response, getEnv());
}
