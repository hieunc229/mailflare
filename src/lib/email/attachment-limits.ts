import type { SendingProvider } from "./outbound-provider-types";

export const DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB = 25;
/** Workers hold each file in a 128 MB isolate while it is read and sent, so 25 MB stays the ceiling there. */
const WORKERS_ATTACHMENT_CEILING_MB = 25;
/** Node/Docker have far more memory. */
const NODE_ATTACHMENT_CEILING_MB = 50;
/** Cloudflare Email Sending sends files over this size as download links. */
export const CLOUD_ATTACHMENT_THRESHOLD_BYTES = 3_000_000;

/** The most an administrator can allow on this runtime. */
export function outboundAttachmentCeilingMb(nodeRuntime: boolean): number {
	return nodeRuntime ? NODE_ATTACHMENT_CEILING_MB : WORKERS_ATTACHMENT_CEILING_MB;
}

/** A stored or submitted limit forced into 1 to the runtime's ceiling; unusable values give the default. */
export function clampOutboundAttachmentMb(value: number | null | undefined, nodeRuntime: boolean): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB;
	return Math.min(Math.max(Math.trunc(value), 1), outboundAttachmentCeilingMb(nodeRuntime));
}

const LEGACY_REQUEST_BODY_BYTES = 30 * 1024 * 1024;
const CLOUDFLARE_MESSAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const MIME_SAFETY_MARGIN_BYTES = 256 * 1024;
/** Resend and SES attach directly up to 20 MB: encoding grows a file by a third, and many receiving servers refuse messages over about 25 MB. Larger files go as download links. */
const OTHER_PROVIDER_ATTACHMENT_BYTES = 20_000_000;

/** An error message when the files break the administrator's limit (each file and all files together), else null. */
export function outgoingSizeError(sizes: number[], maxMb: number): string | null {
	const maxBytes = maxMb * 1_000_000;
	if (sizes.some((size) => size > maxBytes) || sizes.reduce((total, size) => total + size, 0) > maxBytes) {
		return `Attachments exceed the administrator's ${maxMb} MB outgoing limit`;
	}
	return null;
}

/** Largest request body a send or upload may carry: the old 30 MiB cap until the limit is raised, then room for a base64 body. */
export function requestBodyLimit(maxMb: number): number {
	if (maxMb <= DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB) return LEGACY_REQUEST_BODY_BYTES;
	return Math.ceil((maxMb * 1_000_000 * 4) / 3) + 5 * 1024 * 1024;
}

/**
 * For each file, true when it must go as a Shared Files link instead of an attachment.
 * `baseBytes` is the size of the message without its files (Cloudflare counts the whole encoded message).
 */
export function planAttachmentDelivery(provider: SendingProvider, sizes: number[], baseBytes: number): boolean[] {
	let used = provider === "cloudflare" ? baseBytes : 0;
	return sizes.map((size) => {
		if (provider === "cloudflare") {
			const encoded = Math.ceil(size / 3) * 4 + 2048;
			const direct = size <= CLOUD_ATTACHMENT_THRESHOLD_BYTES && used + encoded <= CLOUDFLARE_MESSAGE_LIMIT_BYTES - MIME_SAFETY_MARGIN_BYTES;
			if (direct) used += encoded;
			return !direct;
		}
		const direct = size <= OTHER_PROVIDER_ATTACHMENT_BYTES && used + size <= OTHER_PROVIDER_ATTACHMENT_BYTES;
		if (direct) used += size;
		return !direct;
	});
}
