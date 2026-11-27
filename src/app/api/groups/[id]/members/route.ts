import { addMembers } from "@/lib/groups/service";
import { addGroupMembersSchema } from "@/lib/validators";
import { readJson, requireGroupsAdmin, respond, validationError } from "../../utils";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const access = await requireGroupsAdmin(request, { mutation: true });
	if (access.error) return access.error;
	const parsed = addGroupMembersSchema.safeParse(await readJson(request));
	if (!parsed.success) return validationError(parsed.error);
	const { id } = await params;
	return respond(() => addMembers(access.env, access.db, access.user, id, parsed.data.members));
}
