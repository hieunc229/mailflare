import { NextResponse } from "next/server";
import { addMembers, removeMember, updateMember } from "@/lib/groups/service";
import { addGroupMembersSchema, updateGroupMemberSchema } from "@/lib/validators";
import { readJson, requireGroupsKey, respond, validationError } from "../../utils";

type Context = { params: Promise<{ id: string }> };

function memberIdOf(request: Request) {
	return new URL(request.url).searchParams.get("memberId");
}

export async function POST(request: Request, { params }: Context) {
	const access = await requireGroupsKey(request);
	if (access.error) return access.error;
	const parsed = addGroupMembersSchema.safeParse(await readJson(request));
	if (!parsed.success) return validationError(parsed.error);
	const { id } = await params;
	return respond(() => addMembers(access.env, access.db, access.user, id, parsed.data.members));
}

export async function PATCH(request: Request, { params }: Context) {
	const access = await requireGroupsKey(request);
	if (access.error) return access.error;
	const memberId = memberIdOf(request);
	if (!memberId) return NextResponse.json({ error: "memberId is required" }, { status: 400 });
	const parsed = updateGroupMemberSchema.safeParse(await readJson(request));
	if (!parsed.success) return validationError(parsed.error);
	const { id } = await params;
	return respond(() => updateMember(access.env, access.db, access.user, id, memberId, parsed.data), { map: (member) => ({ member }) });
}

export async function DELETE(request: Request, { params }: Context) {
	const access = await requireGroupsKey(request);
	if (access.error) return access.error;
	const memberId = memberIdOf(request);
	if (!memberId) return NextResponse.json({ error: "memberId is required" }, { status: 400 });
	const { id } = await params;
	return respond(() => removeMember(access.env, access.db, access.user, id, memberId), { map: () => ({ ok: true }) });
}
