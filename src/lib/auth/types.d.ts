export type UserRole = "admin" | "user";

export type SessionUser = {
	id: string;
	email: string;
	resetEmail: string | null;
	forwardingEmail: string | null;
	passwordHash: string;
	name: string;
	timeZone: string | null;
	role: UserRole;
	isPrimaryAdmin: boolean;
	disabled: boolean;
	canManageMailboxes: boolean;
	canManageDomains: boolean;
	canManageUsers: boolean;
	calendarEnabled: boolean;
	driveEnabled: boolean;
	keyboardShortcutsEnabled: boolean;
	spamProtectionEnabled: boolean;
	trashRetentionDays: number | null;
	showFullRecipientAddresses: boolean;
	remoteContentMode: "ask" | "new_sender" | "allow";
	createdByUserId: string | null;
	createdAt: Date;
};
