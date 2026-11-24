import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { expectedRequestOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { writeOutlookPending } from "@/lib/import/outlook";
import {
	createOAuthState,
	createPkceVerifier,
	isMicrosoftClientId,
	isMicrosoftTenant,
	outlookAuthorizeUrl,
	outlookRedirectUri,
	parseOutlookAppInput,
	pkceChallenge,
	readMicrosoftOAuthConfig,
} from "@/lib/import/outlook-utils";
import type { OutlookApp } from "@/lib/import/outlook-types";

/** Starts the Microsoft sign-in. The PKCE verifier stays in an HttpOnly cookie; the browser only receives the authorize URL. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;

	let app: OutlookApp;
	try {
		app = resolveApp(env, await readJsonBody<{ clientId?: unknown; clientSecret?: unknown; tenant?: unknown }>(request, 8 * 1024));
	} catch (cause) {
		return NextResponse.json({ error: cause instanceof Error ? cause.message : "Microsoft sign-in is not configured" }, { status: 400 });
	}

	const state = createOAuthState();
	const verifier = createPkceVerifier();
	const redirectUri = outlookRedirectUri(expectedRequestOrigin(request));
	const authorizationUrl = outlookAuthorizeUrl({
		tenant: app.tenant,
		clientId: app.clientId,
		redirectUri,
		state,
		codeChallenge: await pkceChallenge(verifier),
	});
	const response = NextResponse.json({ authorizationUrl });
	writeOutlookPending(response, { ...app, state, verifier, userId: user.id });
	return response;
}

function resolveApp(env: CloudflareEnv, body: { clientId?: unknown; clientSecret?: unknown; tenant?: unknown }): OutlookApp {
	const configuredId = env.MICROSOFT_CLIENT_ID?.trim() ?? "";
	if (configuredId) {
		if (!isMicrosoftClientId(configuredId)) throw new Error("MICROSOFT_CLIENT_ID is not a valid application id");
		const tenant = env.MICROSOFT_TENANT?.trim() ?? "";
		if (tenant && !isMicrosoftTenant(tenant)) throw new Error("MICROSOFT_TENANT must be common, organizations, consumers, or a directory id");
		const app = readMicrosoftOAuthConfig(env);
		if (!app) throw new Error("Microsoft sign-in is not configured");
		return app;
	}
	return parseOutlookAppInput(body);
}
