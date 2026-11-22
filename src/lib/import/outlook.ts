import { NextResponse } from "next/server";
import type { OutlookApp, OutlookGrant, OutlookPending } from "./outlook-types";
import {
	OUTLOOK_SCOPES,
	decodeOutlookCookie,
	encodeOutlookCookie,
	microsoftTokenError,
	outlookTokenUrl,
	parseOutlookGrant,
	parseOutlookPending,
} from "./outlook-utils";

export const OUTLOOK_PENDING_COOKIE = "mf_outlook_oauth";
export const OUTLOOK_GRANT_COOKIE = "mf_outlook_grant";

const PENDING_MAX_AGE = 10 * 60;
const GRANT_MAX_AGE = 12 * 60 * 60;

const cookieBase = {
	httpOnly: true,
	sameSite: "lax" as const,
	secure: process.env.NODE_ENV === "production",
	path: "/",
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	error?: string;
	error_description?: string;
};

function readRequestCookie(request: Request, name: string): string | null {
	const cookie = request.headers.get("cookie") ?? "";
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

export function writeOutlookPending(response: NextResponse, pending: OutlookPending): void {
	response.cookies.set(OUTLOOK_PENDING_COOKIE, encodeOutlookCookie(pending), { ...cookieBase, maxAge: PENDING_MAX_AGE });
}

export function writeOutlookGrant(response: NextResponse, grant: OutlookGrant): void {
	response.cookies.set(OUTLOOK_GRANT_COOKIE, encodeOutlookCookie(grant), { ...cookieBase, maxAge: GRANT_MAX_AGE });
}

export function clearOutlookPending(response: NextResponse): void {
	response.cookies.set(OUTLOOK_PENDING_COOKIE, "", { ...cookieBase, maxAge: 0 });
}

export function clearOutlookGrant(response: NextResponse): void {
	response.cookies.set(OUTLOOK_GRANT_COOKIE, "", { ...cookieBase, maxAge: 0 });
}

export function readOutlookPending(request: Request): OutlookPending | null {
	const raw = readRequestCookie(request, OUTLOOK_PENDING_COOKIE);
	if (!raw) return null;
	return parseOutlookPending(decodeOutlookCookie(raw));
}

/** The grant belongs to the user who started the sign-in. A switched account does not inherit it. */
export function outlookGrantForUser(request: Request, userId: string): OutlookGrant | null {
	const raw = readRequestCookie(request, OUTLOOK_GRANT_COOKIE);
	if (!raw) return null;
	const grant = parseOutlookGrant(decodeOutlookCookie(raw));
	if (!grant || grant.userId !== userId) return null;
	return grant;
}

async function postToken(tenant: string, body: URLSearchParams): Promise<TokenResponse> {
	let response: Response;
	try {
		response = await fetch(outlookTokenUrl(tenant), {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body,
		});
	} catch {
		throw new Error("Microsoft token endpoint unavailable");
	}
	const payload = (await response.json().catch(() => ({}))) as TokenResponse;
	if (response.status >= 500) throw new Error("Microsoft token endpoint unavailable");
	if (!response.ok || !payload.access_token) throw new Error(microsoftTokenError(payload));
	return payload;
}

function tokenParams(app: OutlookApp, extra: Record<string, string>): URLSearchParams {
	const body = new URLSearchParams({ client_id: app.clientId, scope: OUTLOOK_SCOPES, ...extra });
	if (app.clientSecret) body.set("client_secret", app.clientSecret);
	return body;
}

export async function exchangeOutlookCode(input: {
	app: OutlookApp;
	code: string;
	redirectUri: string;
	verifier: string;
}): Promise<{ accessToken: string; refreshToken: string; idToken: string }> {
	const payload = await postToken(
		input.app.tenant,
		tokenParams(input.app, {
			grant_type: "authorization_code",
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
		}),
	);
	if (!payload.refresh_token || !payload.id_token) {
		throw new Error("Microsoft did not return a refresh token. The app needs the offline_access scope.");
	}
	return { accessToken: payload.access_token!, refreshToken: payload.refresh_token, idToken: payload.id_token };
}

/** Access tokens last about an hour. Each import chunk asks for a fresh one, and keeps a rotated refresh token. */
export async function refreshOutlookAccessToken(input: OutlookApp & { refreshToken: string }): Promise<{ accessToken: string; refreshToken: string }> {
	const payload = await postToken(
		input.tenant,
		tokenParams(input, { grant_type: "refresh_token", refresh_token: input.refreshToken }),
	);
	return { accessToken: payload.access_token!, refreshToken: payload.refresh_token || input.refreshToken };
}
