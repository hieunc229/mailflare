import { NextResponse } from "next/server";
import { saveAutoUpdateSettings } from "@/lib/update/auto-update";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { authorizeAdminRequest } from "./utils";

export async function PATCH(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;
	if (!hasValidSessionMutationOrigin(request)) {
		return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
	}

	const body = (await request.json().catch(() => null)) as { autoUpdate?: unknown; channel?: unknown } | null;
	const autoUpdate = body?.autoUpdate;
	const channel = body?.channel;
	if ((autoUpdate !== undefined && typeof autoUpdate !== "boolean") || (channel !== undefined && channel !== "release" && channel !== "commit") || (autoUpdate === undefined && channel === undefined)) {
		return NextResponse.json({ error: "autoUpdate must be a boolean and channel release or commit" }, { status: 400 });
	}

	try {
		await saveAutoUpdateSettings(authorization.env, { enabled: autoUpdate, channel });
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Could not save the auto-update setting. Apply pending database migrations first." }, { status: 500 });
	}
}
