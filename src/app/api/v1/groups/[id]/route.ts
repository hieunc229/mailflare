import { deleteGroup, getGroup, updateGroup } from "@/lib/groups/service";
import { updateGroupSchema } from "@/lib/validators";
import { readJson, requireGroupsKey, respond, validationError } from "../utils";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
	const access = await requireGroupsKey(request);
	if (access.error) return access.error;
	const { id } = await params;
	return respond(() => getGroup(access.db, access.user, id));
}

export async function PATCH(request: Request, { params }: Context) {
	const access = await requireGroupsKey(request);
	if (access.error) return access.error;
	const parsed = updateGroupSchema.safeParse(await readJson(request));
	if (!parsed.success) return validationError(parsed.error);
	const { id } = await params;
	return respond(() => updateGroup(access.env, access.db, access.user, id, parsed.data), { map: (group) => ({ group }) });
}

export async function DELETE(request: Request, { params }: Context) {
	const access = await requireGroupsKey(request);
	if (access.error) return access.error;
	const { id } = await params;
	return respond(() => deleteGroup(access.env, access.db, access.user, id), { map: () => ({ ok: true }) });
}
