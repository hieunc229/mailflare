import { NextResponse } from "next/server";
import { restoreAccount } from "@/lib/accounts/deletion";
import { requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

export async function POST(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const result = await restoreAccount(access.env, access.user!, id);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	return NextResponse.json({ ok: true });
}
