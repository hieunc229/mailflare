export type SetupStatus = {
	hasPrimaryDomain: boolean;
	primaryDomain?: { hostname: string } | null;
};

export type DomainSetupResult = {
	domain?: { hostname: string };
	error?: string;
};

export type RegisterResult = {
	redirect?: string;
	error?: string;
};
