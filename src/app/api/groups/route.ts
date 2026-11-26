import { NextResponse } from "next/server";
import { createGroup, listGroups } from "@/lib/groups/service";
import { createGroupSchema } from "@/lib/validators";
import { readJson, requireGroupsAdmin, respond } from "./utils";

export async function GET(request: Request) {
	const access = await requireGroupsAdmin(request);
	if (access.error) return access.error;
	return respond(() => listGroups(access.db, access.user));
}

export async function POST(request: Request) {
	const access = await requireGroupsAdmin(request, { mutation: true });
	if (access.error) return access.error;
	const parsed = createGroupSchema.safeParse(await readJson(request));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	return respond(() => createGroup(access.env, access.db, access.user, { ...parsed.data, description: parsed.data.description ?? null }), {
		status: 201,
		map: (group) => ({ group }),
	});
}
