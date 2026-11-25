import type { ContactRunResult } from "./takeout-contacts-card-types";

/** "failed" when nothing worked, "partial" when something failed or the run was stopped or limited, else "success". */
export function contactsTone(results: ContactRunResult[]): "success" | "partial" | "failed" {
	let worked = 0;
	let problem = false;
	for (const { mode, summary } of results) {
		// A preview works on the whole file; an import counts what the server took.
		worked += mode === "import" ? summary.created + summary.updated + summary.unchanged : summary.withEmail;
		problem ||= summary.failed > 0 || summary.photosFailed > 0 || summary.aborted || summary.rateLimited;
	}
	if (!problem) return "success";
	return worked === 0 ? "failed" : "partial";
}

/**
 * Only the owner of an address book may import into it: the server answers 404 to a delegate of a shared mailbox, even
 * with full access. When the owner or the user is not known yet the import is left open and the server decides.
 */
export function isAddressBookOwner(mailbox: { userId?: string } | null, userId: string | undefined): boolean {
	return !mailbox?.userId || !userId || mailbox.userId === userId;
}
