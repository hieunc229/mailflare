export type ApiKey = {
	id: string;
	name: string;
	prefix: string;
	scopes: string;
	createdAt?: string;
	lastUsedAt?: string | null;
};
