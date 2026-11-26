import { NextResponse } from "next/server";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { BackupRestoreError, restoreDatabaseRecords } from "@/lib/backups/export";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { MAX_UPLOAD_BYTES, resolveUploadedRequest } from "@/lib/uploads/direct";

export async function POST(request: Request) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertPrimaryAdmin(user);
		if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
		const form = await (await resolveUploadedRequest(env, request, user.id, MAX_UPLOAD_BYTES)).formData();
		const file = form.get("backup");
		if (!(file instanceof File)) return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		await restoreDatabaseRecords(env.DB, await file.arrayBuffer());
		return NextResponse.json({ ok: true });
	} catch (error) {
		// Only a refusal we wrote ourselves is safe to repeat: it names a table, column or migration. Anything
		// else — a driver error on an insert, whose message repeats the statement and its bound parameters — could
		// carry row values, and `external_accounts` rows hold sealed credentials, so it stays out of the response.
		const message = error instanceof BackupRestoreError ? error.message : "The backup could not be restored. Check the server log.";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
