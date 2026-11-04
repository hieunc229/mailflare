export type RuleFolder = {
	id: string;
	name: string;
};

export type InboxRule = {
	id: string;
	pattern: string;
	matchField: "email" | "content" | "title";
	matchOperator: "contains" | "exact";
	matchValue: string;
	action: "store" | "forward" | "reject" | "spam" | "trash";
	folderId: string | null;
	forwardTo: string | null;
	keepCopy: boolean;
	priority: number;
};

export type InboxRuleInput = {
	mailboxId: string;
	matchField: "email" | "content" | "title";
	matchOperator: "contains" | "exact";
	matchValue: string;
	destination: string;
	forwardTo?: string;
	keepCopy?: boolean;
	priority: number;
};

export type InboxRulesResponse = {
	rules: InboxRule[];
	error?: string;
};

export type RuleFoldersResponse = {
	folders: RuleFolder[];
	error?: string;
};
