import { searchCandidates } from "@/lib/groups/service";
import { requireGroupsAdmin, respond } from "../../utils";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const access = await requireGroupsAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const query = new URL(request.url).searchParams.get("q") ?? "";
	return respond(() => searchCandidates(access.db, access.user, id, query), { map: (candidates) => ({ candidates }) });
}
