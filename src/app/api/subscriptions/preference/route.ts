import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { refileSenderMessages, setSenderOverride } from "@/lib/promotions/refile";
import { parsePreferenceBody, targetOf } from "@/lib/promotions/refile-utils";
import { authorizeMutation, checkManagedMailbox, isMissingSchema, MIGRATION_REQUIRED } from "@/lib/promotions/route-guards";

/**
 * Sets (or with `category: null` clears) the sender's "always Inbox" / "always Promotions" override, then re-files
 * that sender's recent mail (bounded, see refileSenderMessages). Clearing leaves mail where it is.
 */
export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await authorizeMutation(env, request);
	if (auth.error) return auth.error;
	const parsed = parsePreferenceBody(await request.json().catch(() => null));
	if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const db = getDb(env);
	const denied = await checkManagedMailbox(db, auth.user, parsed.mailboxId);
	if (denied) return denied;

	try {
		await setSenderOverride(db, { mailboxId: parsed.mailboxId, senderAddress: parsed.senderAddress, override: parsed.category, userId: auth.user.id });
		const { changed, remainingOlder } = parsed.category
			? await refileSenderMessages(db, { mailboxId: parsed.mailboxId, senderAddress: parsed.senderAddress, target: targetOf(parsed.category) })
			: { changed: 0, remainingOlder: 0 };
		return NextResponse.json({ category: parsed.category, changed, remainingOlder });
	} catch (error) {
		if (isMissingSchema(error)) return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
		throw error;
	}
}
