import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups, backupSettings } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { BackupScheduleType, BackupTableGroupId } from "./types";
import { BACKUP_SETTINGS_ID, getUtcDayBounds, isBackupDue } from "./utils";
import { parseExcludedBackupTableGroups } from "./table-groups";

export async function getBackupSettings(env: CloudflareEnv) {
	const db = getDb(env);
	const [settings] = await db
		.select()
		.from(backupSettings)
		.where(eq(backupSettings.id, BACKUP_SETTINGS_ID))
		.limit(1);
	return settings ? { ...settings, excludedTableGroups: parseExcludedBackupTableGroups(settings.excludedTableGroups) } : undefined;
}

/** A backup normally finishes in minutes; one still queued or running after this was killed with its Worker. */
const STUCK_BACKUP_MS = 30 * 60_000;

/**
 * Marks backups that never finished as failed. A run killed mid-way (memory, deploy, timeout) cannot record its own
 * failure, and a `running` row is never reaped by retention nor deletable, so it would stay in progress forever.
 */
export async function failStuckBackups(env: CloudflareEnv, now = new Date()): Promise<void> {
	await getDb(env)
		.update(backups)
		.set({ status: "failed", error: "The backup did not finish (the run was stopped before it could report).", completedAt: now })
		.where(and(inArray(backups.status, ["queued", "running"]), lt(backups.createdAt, new Date(now.getTime() - STUCK_BACKUP_MS))));
}

export async function listBackups(env: CloudflareEnv) {
	await failStuckBackups(env);
	return getDb(env).select().from(backups).orderBy(desc(backups.createdAt)).limit(100);
}

export async function createBackupRecord(
	env: CloudflareEnv,
	trigger: "manual" | "scheduled",
	createdByUserId?: string,
) {
	const id = newId("bak");
	await getDb(env).insert(backups).values({
		id,
		trigger,
		createdByUserId: createdByUserId ?? null,
	});
	return id;
}

export async function createScheduledBackupIfDue(env: CloudflareEnv, now: Date): Promise<string | null> {
	const settings = await getBackupSettings(env);
	if (!settings?.enabled) return null;
	if (!isBackupDue(settings.scheduleType as BackupScheduleType, settings.scheduleValue, now)) return null;

	const { start, end } = getUtcDayBounds(now);
	const existing = await getDb(env)
		.select({ id: backups.id })
		.from(backups)
		.where(
			and(
				eq(backups.trigger, "scheduled"),
				inArray(backups.status, ["queued", "running", "completed"]),
				gte(backups.createdAt, new Date(start)),
				lt(backups.createdAt, new Date(end)),
			),
		)
		.limit(1);
	if (existing.length) return null;
	return createBackupRecord(env, "scheduled");
}

export async function updateBackupSettings(
	env: CloudflareEnv,
	input: {
		enabled: boolean;
		scheduleType: BackupScheduleType;
		scheduleValue: number | null;
		retentionEnabled: boolean;
		retentionDays: number;
		excludedTableGroups: BackupTableGroupId[];
	},
) {
	const { excludedTableGroups, ...settings } = input;
	await getDb(env)
		.update(backupSettings)
		.set({ ...settings, excludedTableGroups: JSON.stringify(excludedTableGroups), updatedAt: new Date() })
		.where(eq(backupSettings.id, BACKUP_SETTINGS_ID));
}

export async function deleteBackup(env: CloudflareEnv, id: string): Promise<boolean> {
	const db = getDb(env);
	await failStuckBackups(env);
	const [backup] = await db.select().from(backups).where(eq(backups.id, id)).limit(1);
	if (!backup) return false;
	if (backup.status === "queued" || backup.status === "running") {
		throw new Error("A backup in progress cannot be deleted");
	}
	if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
	await db.delete(backups).where(eq(backups.id, id));
	return true;
}
