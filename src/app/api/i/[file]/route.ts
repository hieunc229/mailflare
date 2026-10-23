import { getEnv } from "@/lib/cloudflare";
import { recordOpen } from "@/lib/tracking/open-tracking";
import { parseTrackingToken, TRACKING_PIXEL_GIF, TRACKING_PIXEL_HEADERS } from "@/lib/tracking/open-tracking-utils";

type CloudflareRequest = Request & { cf?: { asn?: number; country?: string; city?: string } };

/** Public read-receipt pixel. Answers the same GIF for every token so it cannot be used to probe them. */
export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
	const token = parseTrackingToken((await params).file);
	if (token) {
		const cf = (request as CloudflareRequest).cf;
		try {
			await recordOpen(getEnv(), token, {
				userAgent: request.headers.get("user-agent"),
				asn: typeof cf?.asn === "number" ? cf.asn : undefined,
				country: cf?.country ?? request.headers.get("cf-ipcountry"),
				city: cf?.city ?? null,
			});
		} catch (error) {
			console.error("Recording a read receipt failed", error);
		}
	}
	return new Response(TRACKING_PIXEL_GIF, { headers: TRACKING_PIXEL_HEADERS });
}
