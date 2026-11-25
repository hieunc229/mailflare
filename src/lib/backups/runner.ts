import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { writeDatabaseBackup } from "./export";
import { createScheduledBackupIfDue, getBackupSettings } from "./service";
import { BACKUP_PREFIX, createBackupFilename } from "./utils";

export async function runDatabaseBackup(env: CloudflareEnv, backupId: string): Promise<void> {
	const db = getDb(env);
	try {
		await db
			.update(backups)
			.set({ status: "running", startedAt: new Date() })
			.where(eq(backups.id, backupId));

		const settings = await getBackupSettings(env);
		const filename = createBackupFilename(new Date());
		const r2Key = `${BACKUP_PREFIX}/${backupId}/${filename}`;
		const size = await writeDatabaseBackup(env.DB, env.BUCKET, r2Key, settings?.excludedTableGroups ?? [], { customMetadata: { backupId } });

		await db
			.update(backups)
			.set({
				status: "completed",
				filename,
				r2Key,
				size,
				completedAt: new Date(),
				error: null,
			})
			.where(eq(backups.id, backupId));
		await deleteExpiredBackups(env);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Backup failed";
		await db
			.update(backups)
			.set({ status: "failed", error: message, completedAt: new Date() })
			.where(eq(backups.id, backupId));
		throw error;
	}
}

export async function runScheduledDatabaseBackup(env: CloudflareEnv, now: Date): Promise<void> {
	const backupId = await createScheduledBackupIfDue(env, now);
	if (backupId) {
		await runDatabaseBackup(env, backupId);
		return;
	}
	await deleteExpiredBackups(env);
}

export async function deleteExpiredBackups(env: CloudflareEnv): Promise<number> {
	const settings = await getBackupSettings(env);
	if (!settings?.retentionEnabled) return 0;

	const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
	const db = getDb(env);
	const expired = await db
		.select()
		.from(backups)
		.where(
			and(
				lt(backups.createdAt, cutoff),
				inArray(backups.status, ["completed", "failed"]),
			),
		);
	for (const backup of expired) {
		if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
		await db.delete(backups).where(eq(backups.id, backup.id));
	}
	return expired.length;
}
