import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { expectedRequestOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { clearOutlookGrant, outlookGrantForUser } from "@/lib/import/outlook";
import { isMicrosoftClientId, isMicrosoftTenant, outlookRedirectUri, readMicrosoftOAuthConfig } from "@/lib/import/outlook-utils";

function microsoftConfigError(env: CloudflareEnv): string | null {
	const clientId = env.MICROSOFT_CLIENT_ID?.trim() ?? "";
	if (!clientId) return null;
	if (!isMicrosoftClientId(clientId)) return "MICROSOFT_CLIENT_ID is not a valid application id";
	const tenant = env.MICROSOFT_TENANT?.trim() ?? "";
	if (tenant && !isMicrosoftTenant(tenant)) return "MICROSOFT_TENANT must be common, organizations, consumers, or a directory id";
	return null;
}

/** Whether this server has an Entra app, and whether this browser already signed in to Outlook. */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const grant = outlookGrantForUser(request, user.id);
	const tenant = env.MICROSOFT_TENANT?.trim() ?? "";
	return NextResponse.json({
		configured: !!readMicrosoftOAuthConfig(env),
		redirectUri: outlookRedirectUri(expectedRequestOrigin(request)),
		tenant: isMicrosoftTenant(tenant) ? tenant : "common",
		configError: microsoftConfigError(env),
		connected: !!grant,
		username: grant?.username ?? null,
	});
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const { error } = await requireSessionUser(env, request);
	if (error) return error;
	const response = NextResponse.json({ ok: true });
	clearOutlookGrant(response);
	return response;
}
