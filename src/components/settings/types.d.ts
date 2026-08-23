export type ProfileFormProps = {
	initialName: string;
	initialResetEmail: string;
	email: string;
};

export type ProfileFormResponse = {
	user?: {
		name: string;
		resetEmail: string | null;
	};
	error?: unknown;
};

export type CurrentMailboxFormResponse = {
	mailbox?: {
		id: string;
		localPart: string;
		hostname: string;
		displayName: string | null;
		forwardTo: string | null;
		isPrimary?: boolean;
	};
	error?: unknown;
};
