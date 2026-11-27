import type { EXTERNAL_ACCOUNT_PROTOCOLS, EXTERNAL_ACCOUNT_TLS_MODES } from "./protocols";

export type ExternalAccountProtocol = (typeof EXTERNAL_ACCOUNT_PROTOCOLS)[number];
export type ExternalAccountTlsMode = (typeof EXTERNAL_ACCOUNT_TLS_MODES)[number];

/**
 * What the API returns for an account. The password never appears here: `passwordSet` says whether one is
 * stored, and the ciphertext is not round-tripped to any client.
 */
export type ExternalAccountView = {
	id: string;
	protocol: ExternalAccountProtocol;
	host: string;
	port: number;
	tlsMode: ExternalAccountTlsMode;
	username: string;
	enabled: boolean;
	passwordSet: boolean;
	lastSyncedAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
};
