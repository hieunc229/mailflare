import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { newId } from "@/lib/ids";
import { firstRunRegisterSchema, primaryDomainRegisterSchema } from "@/lib/validators";
import { addDomainForUser } from "@/lib/domains/service";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { getPrimaryDomain } from "@/lib/user";

export async function POST(request: Request) {
	const env = getEnv();
	const body = await request.json();
	const db = getDb(env);
	const primaryDomain = await getPrimaryDomain(env);
	const primaryDomainExists = !!primaryDomain;
	const isFirstRun = !primaryDomainExists;
	const firstRunParsed = isFirstRun ? firstRunRegisterSchema.safeParse(body) : null;
	const registerParsed = isFirstRun ? null : primaryDomainRegisterSchema.safeParse(body);

	if (firstRunParsed && !firstRunParsed.success) {
		return NextResponse.json({ error: firstRunParsed.error.flatten() }, { status: 400 });
	}

	if (registerParsed && !registerParsed.success) {
		return NextResponse.json({ error: registerParsed.error.flatten() }, { status: 400 });
	}

	const domainName = firstRunParsed?.success ? firstRunParsed.data.domain.toLowerCase().trim() : null;
	const username = (firstRunParsed?.success ? firstRunParsed.data.username : registerParsed!.data.username)
		.toLowerCase()
		.trim();
	const email = firstRunParsed?.success
		? `${username}@${domainName}`
		: `${username}@${primaryDomain!.hostname}`;
	const password = firstRunParsed?.success ? firstRunParsed.data.password : registerParsed!.data.password;
	const name = username;

	const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
	if (existing) {
		return NextResponse.json({ error: "Email already registered" }, { status: 409 });
	}

	const userId = newId("usr");
	await db.insert(users).values({
		id: userId,
		email,
		resetEmail: firstRunParsed?.success ? firstRunParsed.data.resetEmail : registerParsed!.data.resetEmail,
		passwordHash: hashPassword(password),
		name,
	});

	if (isFirstRun) {
		try {
			const { domain } = await addDomainForUser(env, userId, domainName!, {
				enableRouting: true,
				enableSending: true,
			});
			await ensureEmailRoutingRuleToWorker(env, domain.zoneId, email);
			await db.insert(mailboxes).values({
				id: newId("mbx"),
				userId,
				domainId: domain.id,
				localPart: username!,
				displayName: username!,
			});
		} catch (err) {
			await db.delete(users).where(eq(users.id, userId));
			const message = err instanceof Error ? err.message : "Domain setup failed";
			return NextResponse.json({ error: message }, { status: 502 });
		}
	}

	if (!isFirstRun) {
		const [existingMailbox] = await db
			.select()
			.from(mailboxes)
			.where(and(eq(mailboxes.domainId, primaryDomain!.id), eq(mailboxes.localPart, username)))
			.limit(1);
		if (existingMailbox) {
			await db.delete(users).where(eq(users.id, userId));
			return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });
		}

		try {
			await ensureEmailRoutingRuleToWorker(env, primaryDomain!.zoneId, email);
			await db.insert(mailboxes).values({
				id: newId("mbx"),
				userId,
				domainId: primaryDomain!.id,
				localPart: username,
				displayName: username,
			});
		} catch (err) {
			await db.delete(users).where(eq(users.id, userId));
			const message = err instanceof Error ? err.message : "Mailbox setup failed";
			return NextResponse.json({ error: message }, { status: 502 });
		}
	}

	const token = await createSession(env, userId);
	const response = NextResponse.json({ ok: true, redirect: "/inbox" });
	response.cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	return response;
}
