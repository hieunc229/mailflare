import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentJobs, mailboxAgentSettings, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getMailboxAccessLevel, listMailboxSenders } from "@/lib/mailboxes/access";
import { getAgentProviderPublicConfig } from "@/lib/agent/provider";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

const schema = z.object({ mailboxId: z.string().min(1), enabled: z.boolean(), modelId: z.string().max(200).nullable().optional(), autoDraftEnabled: z.boolean(), reviewerUserId: z.string().nullable().optional(), instructions: z.string().max(4_000), dailyLimit: z.number().int().min(1).max(100) });

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return Response.json({ error: "Mailbox required" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return Response.json({ error: "Mailbox not found" }, { status: 404 });
	const [settings] = await db.select().from(mailboxAgentSettings).where(eq(mailboxAgentSettings.mailboxId, mailboxId)).limit(1);
	const reviewers: { id: string; name: string; email: string }[] = [];
	if (access.canManage) {
		reviewers.push(...(await listMailboxSenders(db, access.mailbox)));
	}
	const agentProvider = await getAgentProviderPublicConfig(env);
	const provider = agentProvider.configured ? { kind: agentProvider.provider === "cloudflare" ? "Cloudflare Workers AI" : agentProvider.preset === "custom" ? "OpenAI-compatible API" : agentProvider.preset, model: agentProvider.model } : null;
	const modelId = settings?.modelId && agentProvider.models.includes(settings.modelId) ? settings.modelId : agentProvider.models[0] ?? null;
	return Response.json({ settings: settings ? { ...settings, enabled: true, modelId } : { mailboxId, enabled: true, modelId, autoDraftEnabled: false, reviewerUserId: access.mailbox.userId, instructions: "", dailyLimit: 25 }, models: agentProvider.models, 		canManage: access.canManage, canConfigureProvider: isPrimaryAdmin(user), providerConfigured: agentProvider.configured, provider, autoReplyEnabled: access.mailbox.autoReplyEnabled, reviewers });
}

export async function PUT(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid settings" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canManage) return Response.json({ error: "Mailbox not found or permission denied" }, { status: 403 });
	const reviewerId = parsed.data.reviewerUserId || access.mailbox.userId;
	const [reviewer] = await db.select().from(users).where(eq(users.id, reviewerId)).limit(1);
	if (!reviewer || reviewer.disabled || !(await getMailboxAccessLevel(db, reviewer, parsed.data.mailboxId))?.canSendOnBehalf) return Response.json({ error: "Reviewer needs mailbox send permission" }, { status: 400 });
	if (parsed.data.autoDraftEnabled && access.mailbox.autoReplyEnabled) return Response.json({ error: "Disable the out-of-office auto-reply before enabling AI drafts" }, { status: 400 });
	const agentProvider = await getAgentProviderPublicConfig(env);
	if (parsed.data.modelId && !agentProvider.models.includes(parsed.data.modelId)) return Response.json({ error: "Choose a configured model" }, { status: 400 });
	const modelId = parsed.data.modelId || agentProvider.models[0] || null;
	await db.insert(mailboxAgentSettings).values({ ...parsed.data, enabled: true, modelId, reviewerUserId: reviewerId }).onConflictDoUpdate({ target: mailboxAgentSettings.mailboxId, set: { enabled: true, modelId, autoDraftEnabled: parsed.data.autoDraftEnabled, reviewerUserId: reviewerId, instructions: parsed.data.instructions, dailyLimit: parsed.data.dailyLimit, updatedAt: new Date() } });
	if (!parsed.data.autoDraftEnabled) await db.update(agentJobs).set({ status: "skipped", reason: "Auto-drafting disabled" }).where(and(eq(agentJobs.mailboxId, parsed.data.mailboxId), eq(agentJobs.status, "pending")));
	return Response.json({ ok: true });
}
