import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { isNodeRuntime } from "@/lib/runtime";
import type { UpdateChannel } from "@/app/api/admin/update/types";
import { dispatchUpdateWorkflow, getUpdateStatus } from "@/app/api/admin/update/utils";

const SETTINGS_ID = "default";

/** False until migration 0089 adds the column, so the cron does nothing on an older schema. */
export async function getAutoUpdateSettings(env: CloudflareEnv): Promise<{ enabled: boolean; channel: UpdateChannel }> {
	try {
		const [row] = await getDb(env).select({ autoUpdate: appSettings.autoUpdate, channel: appSettings.autoUpdateChannel }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
		return { enabled: !!row?.autoUpdate, channel: row?.channel === "commit" ? "commit" : "release" };
	} catch {
		return { enabled: false, channel: "release" };
	}
}

export async function saveAutoUpdateSettings(env: CloudflareEnv, values: { enabled?: boolean; channel?: UpdateChannel }) {
	const set: Partial<typeof appSettings.$inferInsert> = { updatedAt: new Date() };
	if (values.enabled !== undefined) set.autoUpdate = values.enabled;
	if (values.channel !== undefined) set.autoUpdateChannel = values.channel;
	if (values.enabled === false || values.channel !== undefined) set.autoUpdateDispatchedVersion = null;
	await getDb(env).insert(appSettings).values({ id: SETTINGS_ID, ...set }).onConflictDoUpdate({ target: appSettings.id, set });
}

/**
 * Cron step. A deploy from the Git integration swaps in a Worker whose bundle knows newer migrations, so the next
 * run applies them; and when a newer release exists upstream it dispatches the update workflow once per version.
 */
export async function runAutoUpdate(env: CloudflareEnv) {
	if (isNodeRuntime(env)) return;
	const settings = await getAutoUpdateSettings(env);
	if (!settings.enabled) return;

	try {
		const migrations = await getMigrationStatus(env.DB);
		if (migrations.pending.length && !migrations.unknown.length) await applyPendingMigrations(env.DB);
	} catch (error) {
		console.error("Auto-update migration failed", error);
		return;
	}

	try {
		const status = await getUpdateStatus(env, settings.channel);
		const target = status.targetCommit ?? status.targetVersion;
		if (!status.available || !target) return;
		const [row] = await getDb(env).select({ version: appSettings.autoUpdateDispatchedVersion }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
		if (row?.version === target) return;
		await dispatchUpdateWorkflow();
		await getDb(env).update(appSettings).set({ autoUpdateDispatchedVersion: target }).where(eq(appSettings.id, SETTINGS_ID));
	} catch (error) {
		console.error("Auto-update dispatch failed", error);
	}
}
