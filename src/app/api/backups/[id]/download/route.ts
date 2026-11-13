import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { authorizeBackupAdmin } from "../../admin";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeBackupAdmin(request);
	if (auth.error) return auth.error;
	const { env } = auth;
	try {
		const { id } = await params;
		const [backup] = await getDb(env).select().from(backups).where(eq(backups.id, id)).limit(1);
		if (!backup?.r2Key) return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
		const object = await env.BUCKET.get(backup.r2Key);
		if (!object) return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
		return new Response(object.body, {
			headers: {
				"Content-Type": "application/sql",
				"Content-Disposition": `attachment; filename="${backup.filename ?? `${backup.id}.sql`}"`,
				"Content-Length": String(object.size),
			},
		});
	} catch {
		return NextResponse.json({ error: "Could not read the backup" }, { status: 500 });
	}
}
