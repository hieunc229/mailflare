export type ImapFormState = {
	host: string;
	port: string;
	secure: boolean;
	username: string;
	password: string;
	folder: string;
	limit: string;
	importAll: boolean;
};

export type ImportSourceSection = "inbox" | "sent" | "drafts" | "archived" | "spam" | "trash" | "others";

export type ImportSourceOption = {
	value: ImportSourceSection;
	label: string;
	imapFolder: string;
	destination: string;
	system?: boolean;
};

export type ImportTab = "file" | "imap";

export type ImportSourceItem = {
	id: string;
	label: string;
	imapFolder: string;
	destination: string;
	folderName?: string;
	sourceSection?: ImportSourceSection;
};

export type ImportFolderSummary = {
	id: string;
	name: string;
};

export type ImportProgress = {
	completed: number;
	label: string;
	total: number;
};
