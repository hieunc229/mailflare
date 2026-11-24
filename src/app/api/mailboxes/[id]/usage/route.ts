import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxSettingsAccess } from "@/lib/mailboxes/settings-access";
import { getMailboxUsage } from "@/lib/mailboxes/usage";
import type { MailboxRouteParams } from "../types";

// Usage exposes mailbox metadata, so it sits behind the same manage gate as the
// mailbox settings actions — a read_only grant is not enough.
export async function GET(request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const access = await getMailboxSettingsAccess(env, user, id);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const usage = await getMailboxUsage(getDb(env), id);
	return NextResponse.json({
		mailboxId: id,
		storageUsed: usage.totalBytes,
		breakdown: {
			bodyBytes: usage.bodyBytes,
			attachmentBytes: usage.attachmentBytes,
			messageCount: usage.messageCount,
		},
		computedAt: new Date().toISOString(),
	});
}
