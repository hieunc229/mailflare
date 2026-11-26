import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { checkLabelAvailable, checkWorkspaceAddress } from "@/lib/tenancy/workspace-settings";

/** Hosted workspaces: `?label=foo`: is `foo.<base domain>` free? Otherwise: does the optional custom address point at the workspace? Primary administrator only. */
export async function GET(request: Request) {
	const env = getEnv();
	if (!env.MAILFLARE_TENANT) return NextResponse.json({ error: "Not found" }, { status: 404 });
	let user;
	try { user = await requireUser(env, request); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
	if (!isPrimaryAdmin(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const label = new URL(request.url).searchParams.get("label");
	if (label !== null) return NextResponse.json(await checkLabelAvailable(env, label), { headers: { "Cache-Control": "no-store" } });
	return NextResponse.json(await checkWorkspaceAddress(env), { headers: { "Cache-Control": "no-store" } });
}
