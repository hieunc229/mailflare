export type RuleTarget = {
	action: "store" | "forward" | "spam" | "trash";
	folderId: string | null;
	forwardTo: string | null;
	keepCopy: boolean;
};
