import { z } from "zod";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { clampOutboundAttachmentMb } from "@/lib/email/attachment-limits";
import { getOutboundAttachmentCeilingMb, getOutboundAttachmentMaxMb, getSharedFilesSettings } from "@/lib/email/attachment-policy";
import { clampSharedLinkDays } from "@/lib/email/shared-file-notice";
import { locales } from "@/lib/i18n/locales";
import { isNodeRuntime } from "@/lib/runtime";
import { getDriveStorageLimit } from "@/lib/drive/storage";

const GIB = 1024 ** 3;

const schema = z.object({
	outboundAttachmentMaxMb: z.number().int().min(1).optional(),
	/** Per-user Drive limit in GB; null removes the limit. */
	driveStorageLimitGb: z.number().positive().max(1_000_000).nullable().optional(),
	/** Shared files notice enable/disable */
	sharedFilesNoticeEnabled: z.boolean().default(true).optional(),
	/** Shared files notice custom text (max 500 chars); null = translated default */
	sharedFilesNoticeText: z.string().max(500).nullable().optional(),
	/** Shared files link expiry in days (1..365) */
	sharedFilesLinkDays: z.number().int().min(1).max(365).optional(),
	/** Shared files notice locale; null = automatic (sender's) */
	sharedFilesNoticeLocale: z.string().nullable().optional(),
	/** Shared files card style: "card" or "links" */
	sharedFilesCardStyle: z.enum(["card", "links"]).default("card").optional(),
});

async function readSettings(env: CloudflareEnv) {
	const limit = await getDriveStorageLimit(env);
	const shared = await getSharedFilesSettings(env);
	return {
		outboundAttachmentMaxMb: await getOutboundAttachmentMaxMb(env),
		outboundAttachmentCeilingMb: getOutboundAttachmentCeilingMb(env),
		driveStorageLimitGb: limit === null ? null : Math.round((limit / GIB) * 100) / 100,
		sharedFilesNoticeEnabled: shared.sharedFilesNoticeEnabled,
		sharedFilesNoticeText: shared.sharedFilesNoticeText,
		sharedFilesLinkDays: shared.sharedFilesLinkDays,
		sharedFilesNoticeLocale: shared.sharedFilesNoticeLocale,
		sharedFilesCardStyle: shared.sharedFilesCardStyle,
	};
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	return Response.json(await readSettings(env), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: `Enter a valid attachment limit (1 to ${getOutboundAttachmentCeilingMb(env)} MB), a Drive storage limit or Shared Files settings` }, { status: 400 });
	const data = parsed.data;
	const anyField = data.outboundAttachmentMaxMb !== undefined || data.driveStorageLimitGb !== undefined || data.sharedFilesNoticeEnabled !== undefined || data.sharedFilesNoticeText !== undefined || data.sharedFilesLinkDays !== undefined || data.sharedFilesNoticeLocale !== undefined || data.sharedFilesCardStyle !== undefined;
	if (!anyField) return Response.json({ error: "No settings to update" }, { status: 400 });
	const values: Partial<typeof appSettings.$inferInsert> = { updatedAt: new Date() };
	if (data.outboundAttachmentMaxMb !== undefined) values.outboundAttachmentMaxMb = clampOutboundAttachmentMb(data.outboundAttachmentMaxMb, isNodeRuntime(env));
	if (data.driveStorageLimitGb !== undefined) values.driveStorageLimitBytes = data.driveStorageLimitGb === null ? null : Math.round(data.driveStorageLimitGb * GIB);
	if (data.sharedFilesNoticeEnabled !== undefined) values.sharedFilesNoticeEnabled = data.sharedFilesNoticeEnabled;
	// An empty box means "use the translated default", stored as null.
	if (data.sharedFilesNoticeText !== undefined) values.sharedFilesNoticeText = data.sharedFilesNoticeText?.trim().slice(0, 500) || null;
	if (data.sharedFilesLinkDays !== undefined) values.sharedFilesLinkDays = clampSharedLinkDays(data.sharedFilesLinkDays);
	// Only a registered catalog is a usable fixed language; anything else falls back to the sender's.
	if (data.sharedFilesNoticeLocale !== undefined) values.sharedFilesNoticeLocale = data.sharedFilesNoticeLocale && Object.hasOwn(locales, data.sharedFilesNoticeLocale) ? data.sharedFilesNoticeLocale : null;
	if (data.sharedFilesCardStyle !== undefined) values.sharedFilesCardStyle = data.sharedFilesCardStyle;
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
	return Response.json(await readSettings(env), { headers: { "Cache-Control": "no-store" } });
}
