import { NextResponse } from "next/server";
import { removeMember, updateMember } from "@/lib/groups/service";
import { updateGroupMemberSchema } from "@/lib/validators";
import { readJson, requireGroupsAdmin, respond } from "../../../utils";

type Context = { params: Promise<{ id: string; memberId: string }> };

export async function PATCH(request: Request, { params }: Context) {
	const access = await requireGroupsAdmin(request, { mutation: true });
	if (access.error) return access.error;
	const parsed = updateGroupMemberSchema.safeParse(await readJson(request));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const { id, memberId } = await params;
	return respond(() => updateMember(access.env, access.db, access.user, id, memberId, parsed.data), { map: (member) => ({ member }) });
}

export async function DELETE(request: Request, { params }: Context) {
	const access = await requireGroupsAdmin(request, { mutation: true });
	if (access.error) return access.error;
	const { id, memberId } = await params;
	return respond(() => removeMember(access.env, access.db, access.user, id, memberId), { map: () => ({ ok: true }) });
}
