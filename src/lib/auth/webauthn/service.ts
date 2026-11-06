import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getWebAuthnConfig } from "./config";
import { findPasskeyByCredentialId, recordPasskeyUse, savePasskey, toWebAuthnCredential, type StoredPasskey } from "./credentials";
import { PasskeyVerificationError } from "./errors";

type User = Pick<typeof users.$inferSelect, "id" | "email" | "name" | "disabled" | "deletedAt">;

export type PasskeyRegistrationResult = {
	passkey: StoredPasskey;
	userVerified: boolean;
};

export type VerifiedPasskeyRegistration = {
	credentialId: string;
	publicKey: Uint8Array;
	counter: number;
	deviceType: string;
	backedUp: boolean;
	/** Authenticator model identifier; may be the all-zero AAGUID. */
	aaguid?: string;
	transports?: string[];
	userVerified: boolean;
};

function transportsOf(passkey: StoredPasskey): string[] | undefined {
	return passkey.transports ? passkey.transports.split(",").filter(Boolean) : undefined;
}

/** Discoverable credentials plus mandatory user verification make a passkey a complete sign-in. */
export async function createRegistrationOptions(
	env: CloudflareEnv,
	request: Request,
	user: User,
	existing: StoredPasskey[],
) {
	const config = await getWebAuthnConfig(env, request);
	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpID,
		userName: user.email,
		userDisplayName: user.name,
		userID: new TextEncoder().encode(user.id),
		attestationType: "none",
		excludeCredentials: existing.map((passkey) => ({ id: passkey.credentialId, transports: transportsOf(passkey) })),
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "required",
		},
	});
	return { options, config };
}

/** `allowCredentials` is omitted for discoverable passwordless sign-in. */
export async function createAuthenticationOptions(
	env: CloudflareEnv,
	request: Request,
	passkeys: StoredPasskey[] | null,
	options: { discoverable?: boolean } = {},
) {
	const config = await getWebAuthnConfig(env, request);
	const generated = await generateAuthenticationOptions({
		rpID: config.rpID,
		allowCredentials: options.discoverable ? undefined : passkeys?.map((passkey) => ({ id: passkey.credentialId, transports: transportsOf(passkey) })) ?? [],
		userVerification: "required",
	});
	return { options: generated, config };
}

/** Verifies only; the caller decides whether and when to persist the credential. */
export async function verifyPasskeyRegistrationResponse(
	env: CloudflareEnv,
	request: Request,
	response: RegistrationResponseJSON,
	expectedChallenge: string,
): Promise<VerifiedPasskeyRegistration> {
	const config = await getWebAuthnConfig(env, request);
	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: config.origin,
		expectedRPID: config.rpID,
		requireUserVerification: true,
	});
	if (!verification.verified || !verification.registrationInfo) throw new Error("Passkey registration could not be verified");
	const info = verification.registrationInfo;
	return {
		credentialId: info.credential.id,
		publicKey: info.credential.publicKey,
		counter: info.credential.counter,
		deviceType: info.credentialDeviceType,
		backedUp: info.credentialBackedUp,
		aaguid: info.aaguid,
		transports: info.credential.transports,
		userVerified: info.userVerified,
	};
}

export async function savePasskeyRegistration(
	env: CloudflareEnv,
	userId: string,
	verified: VerifiedPasskeyRegistration,
	name: string,
): Promise<StoredPasskey> {
	return savePasskey(env, {
		userId,
		credentialId: verified.credentialId,
		publicKey: verified.publicKey,
		counter: verified.counter,
		deviceType: verified.deviceType,
		backedUp: verified.backedUp,
		aaguid: verified.aaguid,
		transports: verified.transports,
		name,
	});
}

export async function verifyPasskeyRegistration(
	env: CloudflareEnv,
	request: Request,
	response: RegistrationResponseJSON,
	expectedChallenge: string,
	user: User,
	name: string,
): Promise<PasskeyRegistrationResult> {
	const verified = await verifyPasskeyRegistrationResponse(env, request, response, expectedChallenge);
	const passkey = await savePasskeyRegistration(env, user.id, verified, name);
	return { passkey, userVerified: verified.userVerified };
}

export async function verifyPasskeyAuthentication(
	env: CloudflareEnv,
	request: Request,
	response: AuthenticationResponseJSON,
	expectedChallenge: string,
	options: { requireUserHandle?: boolean; expectedUser?: User } = {},
): Promise<{ passkey: StoredPasskey & { user: User } }> {
	const passkey = await findPasskeyByCredentialId(env, response.id);
	if (!passkey) throw new PasskeyVerificationError("passkey_not_found");
	const dbUser = options.expectedUser;
	const user = dbUser
		? dbUser
		: (
				await getDb(env).select().from(users).where(eq(users.id, passkey.userId)).limit(1)
			)[0];
	if (!user || user.disabled || user.deletedAt) throw new PasskeyVerificationError("account_disabled");
	if (user.id !== passkey.userId) throw new PasskeyVerificationError("passkey_not_found");

	// A discoverable credential must carry the user handle it was registered with.
	if (options.requireUserHandle) {
		const handle = response.response.userHandle;
		if (!handle) throw new PasskeyVerificationError("passkey_not_found");
		if (isoBase64URL.toUTF8String(handle) !== user.id) throw new PasskeyVerificationError("passkey_not_found");
	}

	const config = await getWebAuthnConfig(env, request);
	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: config.origin,
		expectedRPID: config.rpID,
		credential: toWebAuthnCredential(passkey),
		requireUserVerification: true,
	});
	if (!verification.verified) throw new PasskeyVerificationError("passkey_invalid");
	if (!(await recordPasskeyUse(env, passkey, verification.authenticationInfo.newCounter))) {
		throw new PasskeyVerificationError("passkey_counter_stale");
	}
	return { passkey: Object.assign(passkey, { user }) };
}

function isCredentialResponse(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.rawId === "string" && record.type === "public-key" && !!record.response && typeof record.response === "object";
}

export function isAuthenticationResponseJSON(value: unknown): value is AuthenticationResponseJSON {
	if (!isCredentialResponse(value)) return false;
	const response = value.response as Record<string, unknown>;
	return typeof response.signature === "string" && typeof response.authenticatorData === "string" && typeof response.clientDataJSON === "string";
}

export function isRegistrationResponseJSON(value: unknown): value is RegistrationResponseJSON {
	if (!isCredentialResponse(value)) return false;
	const response = value.response as Record<string, unknown>;
	return typeof response.attestationObject === "string" && typeof response.clientDataJSON === "string";
}
