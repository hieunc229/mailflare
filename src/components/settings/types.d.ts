export type ProfileFormProps = {
	initialName: string;
	initialResetEmail: string;
	email: string;
};

export type ProfileFormResponse = {
	user?: {
		name: string;
		resetEmail: string | null;
		forwardingEmail: string | null;
		canForwardEmail: boolean;
	};
	error?: unknown;
};

export type AccountSettingsResponse = {
	user?: {
		email: string;
		name: string;
		resetEmail: string | null;
		forwardingEmail: string | null;
		barkUrl: string;
		canForwardEmail: boolean;
	};
	error?: unknown;
};

export type ForwardingEmailFormProps = {
	initialForwardingEmail: string;
};

export type BarkSettingsFormProps = {
	initialBarkUrl: string;
};

export type BarkSettingsResponse = {
	barkUrl?: string | null;
	error?: unknown;
};

export type ForwardingEmailResponse = {
	forwardingEmail?: string | null;
	error?: unknown;
};

export type MailboxSignatureResponse = {
	mailbox?: {
		id: string;
		localPart: string;
		hostname: string;
		displayName: string | null;
		signature: string | null;
		hasAvatar?: boolean;
		isPrimary?: boolean;
	};
	error?: unknown;
};

export type MailboxAutoReplySettings = {
	enabled: boolean;
	subject: string;
	body: string;
};

export type MailboxAutoReplyResponse = {
	mailbox?: {
		autoReplyEnabled: boolean;
		autoReplySubject: string;
		autoReplyBody: string;
	};
	error?: unknown;
};

export type ChangePasswordResponse = {
	error?: unknown;
};

export type ProfileAvatarSessionResponse = {
	user?: {
		hasAvatar?: boolean;
	};
};

export type ProfileAvatarUploadResponse = {
	error?: string;
};

export type ProfileAvatarFormProps = {
	mailboxId?: string;
	initialHasAvatar?: boolean;
	name?: string;
};

export type CurrentMailboxFormResponse = {
	mailbox?: {
		id: string;
		localPart: string;
		hostname: string;
		displayName: string | null;
		signature?: string | null;
		hasAvatar?: boolean;
		isPrimary?: boolean;
	};
	error?: unknown;
};
