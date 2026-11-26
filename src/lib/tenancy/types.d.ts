/** What the control plane knows about one tenant (a row of its `tenants` view). */
export interface TenantInfo {
	id: string;
	status: "pending_payment" | "provisioning" | "active" | "past_due" | "suspended" | "deleting" | "deleted";
	/** Display name of the workspace: its branding. */
	name: string;
	/** Address of the workspace's first administrator (created automatically). */
	adminEmail: string | null;
	/** Display name of that administrator (first + last name from signup); null falls back to the email's local part. */
	adminName: string | null;
	/** The workspace's main domain, where the administrator's mailbox lives. */
	domain: string;
	/** bcrypt hash of the administrator's password, set at signup. Null: the account is created without a password. */
	adminPasswordHash: string | null;
	/** The owner's personal email from signup: where the administrator's password reset links go. */
	contactEmail: string | null;
	limits: TenantLimits;
}

/** A missing or negative number means unlimited. */
export interface TenantLimits {
	users?: number;
	mailboxes?: number;
	domains?: number;
	/** Outbound emails each user may send per UTC day. */
	emailsPerUserPerDay?: number;
	/** Recipients the whole workspace may mail per UTC day (free trial only). */
	recipientsPerDay?: number;
	/** Unix seconds: while set and in the future the workspace is in its free trial, with the trial's lower sending limit. */
	trialEndsAt?: number;
	/** 1 once the free trial is over and the workspace never subscribed: the workspace is locked until it upgrades. */
	trialExpired?: number;
	storageBytes?: number;
}
