import { NextResponse } from "next/server";
import { authorizeBackupAdmin } from "../admin";
import { deleteBackup } from "@/lib/backups/service";

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeBackupAdmin(request);
	if (auth.error) return auth.error;
	const { env } = auth;
	try {
		const { id } = await params;
		const deleted = await deleteBackup(env, id);
		if (!deleted) return NextResponse.json({ error: "Backup not found" }, { status: 404 });
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Could not delete the backup" }, { status: 500 });
	}
}
