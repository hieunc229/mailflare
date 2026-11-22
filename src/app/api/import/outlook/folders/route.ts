import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { listImapFolders } from "@/lib/import/imap";
import { outlookGrantForUser, refreshOutlookAccessToken, writeOutlookGrant } from "@/lib/import/outlook";
import { OUTLOOK_IMAP_HOST, OUTLOOK_IMAP_PORT } from "@/lib/import/outlook-utils";

/** Lists the signed-in Outlook mailbox so the import can map folders. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const grant = outlookGrantForUser(request, user.id);
	if (!grant) return NextResponse.json({ error: "Microsoft sign-in expired; connect Outlook again" }, { status: 401 });

	try {
		const refreshed = await refreshOutlookAccessToken(grant);
		const folders = await listImapFolders({
			host: OUTLOOK_IMAP_HOST,
			port: OUTLOOK_IMAP_PORT,
			secure: true,
			username: grant.username,
			password: "",
			accessToken: refreshed.accessToken,
		});
		const response = NextResponse.json({ folders, username: grant.username });
		if (refreshed.refreshToken !== grant.refreshToken) {
			writeOutlookGrant(response, { ...grant, refreshToken: refreshed.refreshToken });
		}
		return response;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "Unable to list Outlook folders";
		const status = /sign-in expired/i.test(message) ? 401 : 502;
		return NextResponse.json({ error: message }, { status });
	}
}
