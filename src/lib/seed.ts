import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";

/** Dev-only seed without Cloudflare API (domain must be onboarded separately). */
export async function seedDemoData(env: CloudflareEnv): Promise<void> {
	const db = getDb(env);
	const userId = newId("usr");
	const domainId = newId("dom");
	const mailboxId = newId("mbx");

	await db.insert(users).values({
		id: userId,
		email: "admin@example.com",
		passwordHash: hashPassword("demo-password-change-me"),
		name: "Demo User",
	});

	await db.insert(domains).values({
		id: domainId,
		userId,
		hostname: "example.com",
		zoneId: "00000000000000000000000000000000",
		status: "active",
		routingEnabled: true,
		sendingEnabled: true,
	});

	await db.insert(mailboxes).values({
		id: mailboxId,
		userId,
		domainId,
		localPart: "support",
		displayName: "Support",
	});

	console.info("Seeded demo user:", { email: "admin@example.com", password: "demo-password-change-me" });
}
