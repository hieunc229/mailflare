import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { cancelWorkspacePlan, getWorkspaceSettings, updateWorkspaceSettings } from "@/lib/tenancy/workspace-settings";

/** Hosted workspaces: the workspace's own settings (name, address, plan). Only its primary administrator. */
async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	if (!env.MAILFLARE_TENANT) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
	let user;
	try { user = await requireUser(env, request); } catch { return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }; }
	if (!isPrimaryAdmin(user)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	if (mutation && !hasValidSessionMutationOrigin(request)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	return { env, user };
}

export async function GET(request: Request) {
	const auth = await authorize(request, false);
	if (auth.error) return auth.error;
	return NextResponse.json(await getWorkspaceSettings(auth.env), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
	const auth = await authorize(request, true);
	if (auth.error) return auth.error;
	const body = (await request.json().catch(() => ({}))) as { name?: string; label?: string };
	try {
		return NextResponse.json(await updateWorkspaceSettings(auth.env, body, auth.user.email));
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save" }, { status: 400 });
	}
}

/** `{ action: "cancel" }`: cancel the plan. The workspace works until the paid period ends, then it is deleted after a week. */
export async function POST(request: Request) {
	const auth = await authorize(request, true);
	if (auth.error) return auth.error;
	const body = (await request.json().catch(() => ({}))) as { action?: string };
	if (body.action !== "cancel") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
	try {
		return NextResponse.json(await cancelWorkspacePlan(auth.env, auth.user.email));
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not cancel the plan" }, { status: 400 });
	}
}
