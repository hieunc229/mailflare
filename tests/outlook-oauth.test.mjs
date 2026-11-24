import assert from "node:assert/strict";
import test from "node:test";

import {
	emailFromIdToken,
	microsoftTokenError,
	outlookAuthorizeUrl,
	parseOutlookGrant,
	pkceChallenge,
	xoauth2InitialResponse,
} from "../src/lib/import/outlook-utils.ts";
import { isImapConnectionError, isPermanentImapError } from "../src/lib/import/imap-utils.ts";

test("XOAUTH2 initial response matches the SASL bearer format", () => {
	const token = "ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg";
	assert.equal(
		xoauth2InitialResponse("someuser@example.com", token),
		"dXNlcj1zb21ldXNlckBleGFtcGxlLmNvbQFhdXRoPUJlYXJlciB5YTI5LnZGOWRmdDRxbVRjMk52YjNSbGNrQmhkSFJoZG1semRHRXVZMjl0Q2cBAQ==",
	);
});

test("PKCE S256 matches RFC 7636 appendix B", async () => {
	assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("authorize URL carries the IMAP scope and the S256 challenge", () => {
	const url = new URL(outlookAuthorizeUrl({
		tenant: "common",
		clientId: "00000000-0000-0000-0000-000000000000",
		redirectUri: "https://mail.example.com/api/import/outlook/callback",
		state: "state",
		codeChallenge: "challenge",
	}));
	assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.match(url.searchParams.get("scope") ?? "", /IMAP\.AccessAsUser\.All/);
	assert.match(url.searchParams.get("scope") ?? "", /offline_access/);
});

test("id token email is read without trusting a missing claim", () => {
	const payload = Buffer.from(JSON.stringify({ preferred_username: "ada@outlook.com" })).toString("base64url");
	assert.equal(emailFromIdToken(`x.${payload}.y`), "ada@outlook.com");
	assert.equal(emailFromIdToken("not-a-token"), null);
});

test("a grant cookie is rejected when it is for another shape", () => {
	assert.equal(parseOutlookGrant({ refreshToken: "t", username: "ada@outlook.com" }), null);
	const grant = parseOutlookGrant({
		clientId: "00000000-0000-0000-0000-000000000000",
		clientSecret: null,
		tenant: "common",
		refreshToken: "t",
		username: "ada@outlook.com",
		userId: "usr_1",
	});
	assert.equal(grant?.username, "ada@outlook.com");
});

test("token errors tell the user to sign in again or fix the app", () => {
	assert.match(microsoftTokenError({ error: "invalid_grant" }), /sign-in expired/);
	assert.match(microsoftTokenError({ error: "invalid_client", error_description: "AADSTS7000218" }), /CLIENT_SECRET|public client/i);
	assert.equal(isPermanentImapError("Microsoft sign-in expired; connect Outlook again"), true);
	assert.equal(isImapConnectionError("Microsoft token endpoint unavailable"), true);
});
