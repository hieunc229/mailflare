import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { expectedRequestOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { clearOutlookPending, exchangeOutlookCode, readOutlookPending, writeOutlookGrant } from "@/lib/import/outlook";
import { emailFromIdToken, outlookRedirectUri } from "@/lib/import/outlook-utils";

/** Microsoft redirects the browser here with the authorization code. */
export async function GET(request: Request) {
	const env = getEnv();
	const origin = expectedRequestOrigin(request);
	const url = new URL(request.url);
	const pending = readOutlookPending(request);
	const fail = (detail: string) => redirect(origin, "error", detail);

	const { user, error } = await requireSessionUser(env, request);
	if (error || !user) return redirect(origin, "error", "Sign in to Mailflare again, then connect Outlook.");

	const returnedState = url.searchParams.get("state") ?? "";
	if (!pending || pending.userId !== user.id || pending.state !== returnedState) {
		return fail("The Microsoft sign-in expired. Start it again.");
	}

	const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error");
	if (oauthError) return fail(oauthError.slice(0, 300));

	const code = url.searchParams.get("code") ?? "";
	if (!code) return fail("Microsoft did not return an authorization code.");

	try {
		const tokens = await exchangeOutlookCode({
			app: pending,
			code,
			redirectUri: outlookRedirectUri(origin),
			verifier: pending.verifier,
		});
		const username = emailFromIdToken(tokens.idToken);
		if (!username) return fail("Microsoft did not return the mailbox address.");
		const response = redirect(origin, "connected");
		writeOutlookGrant(response, {
			clientId: pending.clientId,
			clientSecret: pending.clientSecret,
			tenant: pending.tenant,
			refreshToken: tokens.refreshToken,
			username,
			userId: user.id,
		});
		return response;
	} catch (cause) {
		return fail(cause instanceof Error ? cause.message : "Microsoft sign-in failed");
	}
}

function redirect(origin: string, outlook: "connected" | "error", detail?: string): NextResponse {
	const target = new URL("/settings/import", origin);
	target.searchParams.set("outlook", outlook);
	target.searchParams.set("source", "outlook");
	if (detail) target.searchParams.set("detail", detail.slice(0, 300));
	const response = NextResponse.redirect(target);
	clearOutlookPending(response);
	return response;
}
