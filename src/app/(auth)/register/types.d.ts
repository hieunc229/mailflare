export type SetupStatus = {
	hasAdminAccount: boolean;
	hasPrimaryDomain: boolean;
	primaryDomain?: { hostname: string; sendingRequested: boolean } | null;
	error?: string;
};

export type SetupRequirementCheck = {
	key: string;
	configured: boolean;
	message: string;
};

export type SetupPreparationResult = {
	checks?: SetupRequirementCheck[];
	migrated?: boolean;
	error?: string;
	code?: "SETUP_CODE_REQUIRED" | "SETUP_CODE_INVALID" | "SETUP_CODE_RATE_LIMITED" | "SETUP_CODE_UNAVAILABLE";
};

export type DomainPreflight = {
	hostname: string;
	zone: { id: string; name: string };
};

export type DomainSetupResult = {
	domain?: DomainPreflight;
	error?: string;
};

export type MxCheckResult = {
	hasExistingMx?: boolean;
	error?: string;
};

export type RegisterResult = {
	redirect?: string;
	error?: string;
	code?: "MX_RECORDS_CONFLICT";
};
