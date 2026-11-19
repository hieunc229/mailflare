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

/** The administrator's Shared Files text; null (also while the migration is not applied) means the translated default. */
export async function getSharedFilesNotice(env: CloudflareEnv): Promise<string | null> {
	try {
		const [settings] = await getDb(env)
			.select({ notice: appSettings.sharedFilesNotice })
			.from(appSettings)
			.where(eq(appSettings.id, "default"))
			.limit(1);
		return settings?.notice ?? null;
	} catch {
		return null;
	}
}
