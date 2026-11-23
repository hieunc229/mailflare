import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isNodeRuntime } from "@/lib/runtime";
import { DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB, clampOutboundAttachmentMb, outboundAttachmentCeilingMb } from "./attachment-limits";

export { CLOUD_ATTACHMENT_THRESHOLD_BYTES, DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB } from "./attachment-limits";

/** This runtime's ceiling for the administrator's limit (25 MB on Workers, 50 MB on Node/Docker). */
export function getOutboundAttachmentCeilingMb(env: CloudflareEnv): number {
	return outboundAttachmentCeilingMb(isNodeRuntime(env));
}

/** The administrator's limit, clamped to the runtime's ceiling every time it is used. */
export async function getOutboundAttachmentMaxMb(env: CloudflareEnv): Promise<number> {
	const [settings] = await getDb(env)
		.select({ maxMb: appSettings.outboundAttachmentMaxMb })
		.from(appSettings)
		.where(eq(appSettings.id, "default"))
		.limit(1);
	return clampOutboundAttachmentMb(settings?.maxMb ?? DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB, isNodeRuntime(env));
}

import { clampSharedLinkDays, DEFAULT_SHARED_LINK_DAYS } from "./shared-file-notice";

export type SharedFilesSettings = {
	sharedFilesNoticeEnabled: boolean;
	sharedFilesNoticeText: string | null;
	sharedFilesLinkDays: number;
	sharedFilesNoticeLocale: string | null;
	sharedFilesCardStyle: "card" | "links";
};

const SHARED_FILES_DEFAULTS: SharedFilesSettings = {
	sharedFilesNoticeEnabled: true,
	sharedFilesNoticeText: null,
	sharedFilesLinkDays: DEFAULT_SHARED_LINK_DAYS,
	sharedFilesNoticeLocale: null,
	sharedFilesCardStyle: "card",
};

/**
 * The Shared Files settings, clamped every time they are used. Reading never fails a send: a missing column (the
 * migration has not run yet), a missing row or an unavailable database all fall back to the defaults.
 */
export async function getSharedFilesSettings(env: CloudflareEnv): Promise<SharedFilesSettings> {
	try {
		const [settings] = await getDb(env)
			.select({
				sharedFilesNoticeEnabled: appSettings.sharedFilesNoticeEnabled,
				sharedFilesNoticeText: appSettings.sharedFilesNoticeText,
				sharedFilesLinkDays: appSettings.sharedFilesLinkDays,
				sharedFilesNoticeLocale: appSettings.sharedFilesNoticeLocale,
				sharedFilesCardStyle: appSettings.sharedFilesCardStyle,
			})
			.from(appSettings)
			.where(eq(appSettings.id, "default"))
			.limit(1);
		if (!settings) return SHARED_FILES_DEFAULTS;
		const text = typeof settings.sharedFilesNoticeText === "string" ? settings.sharedFilesNoticeText.trim().slice(0, 500) : "";
		const locale = typeof settings.sharedFilesNoticeLocale === "string" && settings.sharedFilesNoticeLocale.trim() ? settings.sharedFilesNoticeLocale.trim() : null;
		return {
			sharedFilesNoticeEnabled: settings.sharedFilesNoticeEnabled !== false,
			sharedFilesNoticeText: text || null,
			sharedFilesLinkDays: clampSharedLinkDays(settings.sharedFilesLinkDays),
			sharedFilesNoticeLocale: locale,
			sharedFilesCardStyle: settings.sharedFilesCardStyle === "links" ? "links" : "card",
		};
	} catch {
		return SHARED_FILES_DEFAULTS;
	}
}

