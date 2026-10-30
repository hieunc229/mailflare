/**
 * A sensitive change a step-up grant may authorize. Keeping the list explicit
 * stops a grant minted for one change from being spent on another.
 */
export type StepUpAction =
	| "passkey.add"
	| "passkey.remove"
	| "password.set"
	| "password.remove"
	| "mfa.enroll"
	| "mfa.disable"
	| "mfa.codes"
	| "second_factor.toggle"
	| "admin.password_reset"
	| "admin.recovery_link";

export type StepUpGrantInput = {
	token: string;
	action: StepUpAction;
	targetUserId?: string | null;
};
