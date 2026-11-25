import { NextResponse } from "next/server";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { restoreDatabaseRecords } from "@/lib/backups/export";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { getEnv } from "@/lib/cloudflare";
import { isExternalDatabase } from "@/db/external";
import { isNodeRuntime } from "@/lib/runtime";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

/** Workers Paid limit; the Free plan allows 50 and cannot restore a real database either way. */
const D1_QUERIES_PER_INVOCATION = 1000;

export async function POST(request: Request) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertPrimaryAdmin(user);
		if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
		const form = await request.formData();
		const file = form.get("backup");
		if (!(file instanceof File)) return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		const { safetyBackupKey } = await restoreDatabaseRecords(env.DB, await file.arrayBuffer(), { bucket: env.BUCKET, maxQueries: isExternalDatabase(env.DB) || isNodeRuntime(env) ? undefined : D1_QUERIES_PER_INVOCATION });
		console.info("Backup restored", { safetyBackupKey, actor: user.id });
		// The restore replaced the audit log too, so this entry lands in the restored data; best effort, the key is also in the response and the log above.
		await createAuditLog(env, { action: "backup.restored", metadata: { safetyBackupKey, actorUserId: user.id } }).catch((error) => console.error("Restore audit entry failed", error));
		return NextResponse.json({ ok: true, safetyBackupKey });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
