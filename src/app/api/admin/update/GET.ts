import { NextResponse } from "next/server";
import { getAutoUpdateSettings } from "@/lib/update/auto-update";
import { authorizeAdminRequest, getUpdateStatus } from "./utils";

export async function GET(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;

	try {
		const settings = await getAutoUpdateSettings(authorization.env);
		const status = await getUpdateStatus(authorization.env, settings.channel);
		return NextResponse.json({ ...status, autoUpdate: settings.enabled, channel: settings.channel });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not check for updates";
		const status = message.includes("must be configured") ? 503 : 502;
		return NextResponse.json({ error: message }, { status });
	}
}