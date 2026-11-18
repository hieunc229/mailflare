import { NextResponse } from "next/server";
import { getBackupConfigurationStatus } from "@/lib/backups/export";
import { runDatabaseBackup } from "@/lib/backups/runner";
import {
	createBackupRecord,
	getBackupSettings,
	listBackups,
	updateBackupSettings,
} from "@/lib/backups/service";
import { authorizeBackupAdmin } from "./admin";
import { parseBackupSettingsInput } from "./utils";

export async function GET(request: Request) {
	const auth = await authorizeBackupAdmin(request);
	if (auth.error) return auth.error;
	const { env } = auth;
	try {
		const [settings, backupList] = await Promise.all([
			getBackupSettings(env),
			listBackups(env),
		]);
		return NextResponse.json({
			settings,
			backups: backupList,
			configuration: getBackupConfigurationStatus(env),
		});
	} catch {
		return NextResponse.json({ error: "Could not load backups" }, { status: 500 });
	}
}

export async function PUT(request: Request) {
	const auth = await authorizeBackupAdmin(request);
	if (auth.error) return auth.error;
	const body = await request.json().catch(() => null);
	const input = parseBackupSettingsInput(body);
	if (!input) return NextResponse.json({ error: "Invalid backup settings" }, { status: 400 });
	try {
		await updateBackupSettings(auth.env, input);
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Could not save backup settings" }, { status: 500 });
	}
}

export async function POST(request: Request) {
	const auth = await authorizeBackupAdmin(request);
	if (auth.error) return auth.error;
	const { env, user } = auth;
	try {
		const backupId = await createBackupRecord(env, "manual", user.id);
		await runDatabaseBackup(env, backupId);
		return NextResponse.json({ backupId });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to run backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
