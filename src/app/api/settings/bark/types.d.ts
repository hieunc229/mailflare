export type BarkSettingsResponse = {
	barkUrl?: string;
	error?: unknown;
};

export type UpdateBarkSettingsInput = {
	barkUrl: string;
};