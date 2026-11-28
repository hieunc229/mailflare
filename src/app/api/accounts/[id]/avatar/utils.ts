import { getDb } from "@/db";
import { canManageUserAccount, canManageUsers } from "@/lib/auth/admin";
import { requireTeamAdmin } from "../../utils";
import { selectAccountById } from "../utils";

export async function getManagedAccount(request: Request, id: string) {
	const access = await requireTeamAdmin(request);
	if (access.error) return { access, account: null };
	const account = await selectAccountById(getDb(access.env), id);
	// Same rule as PATCH /api/accounts/[id].
	const actor = access.user!;
	if (!account || !canManageUsers(actor) || !canManageUserAccount(actor, account)) {
		return { access, account: null };
	}
	return { access, account };
}
