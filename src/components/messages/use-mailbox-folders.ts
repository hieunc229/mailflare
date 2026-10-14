"use client";

import { useEffect, useState } from "react";
import { getMailboxFolders } from "@/lib/folders/client";
import { getClientSessionToken } from "@/lib/auth/client";
import type { CustomFolder } from "@/components/dashboard-nav-types";

export function useMailboxFolders(mailboxId: string | undefined): CustomFolder[] {
	const [fetched, setFetched] = useState<{ mailboxId: string; sessionToken: string | null; folders: CustomFolder[] } | null>(null);

	useEffect(() => {
		if (!mailboxId) return;
		let cancelled = false;
		getMailboxFolders<{ folders?: CustomFolder[] }>(mailboxId)
			.then((data) => {
				const folders = data.folders ?? [];
				if (!cancelled) setFetched({ mailboxId, sessionToken: getClientSessionToken(), folders });
			})
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [mailboxId]);

	if (!mailboxId) return [];
	return fetched?.mailboxId === mailboxId && fetched.sessionToken === getClientSessionToken() ? fetched.folders : [];
}
