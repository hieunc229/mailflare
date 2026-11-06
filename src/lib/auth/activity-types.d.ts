export type AuthActivityAction =
	| "auth.login"
	| "auth.logout"
	| "auth.mfa_verified"
	| "auth.password_reset"
	| "auth.device_login"
	| "auth.passkey_verified"
	| "auth.passkey_setup"
	| "auth.passkey_added"
	| "auth.passkey_removed"
	| "auth.passkey_renamed"
	| "auth.password_set"
	| "auth.password_removed"
	| "auth.recovery_started"
	| "auth.recovery_completed"
	| "auth.admin_recovery_created"
	| "auth.admin_password_reset";

export type AuthActivityMetadata = {
	ipAddress: string;
	city: string | null;
	country: string | null;
	device: string;
	platform: string;
	userAgent: string;
};
