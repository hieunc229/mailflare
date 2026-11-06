import type { MailtoUnsubscribeTarget, UnsubscribeMethod } from "@/lib/email/unsubscribe-types";

export type { MailtoUnsubscribeTarget };

export type UnsubscribeAction = "unsubscribe" | "unsubscribe_and_trash";

export type UnsubscribePayload = {
	action?: UnsubscribeAction;
	/** Report how many past messages the sender trash sweep would move, without changing anything. */
	previewOnly?: boolean;
};

export type UnsubscribeActionResult =
	| { ok: true; method: Exclude<UnsubscribeMethod, "link">; trashedCount?: number }
	| { ok: true; method: "link"; url: string; trashedCount?: number };

export type UnsubscribePreviewResult = { ok: true; preview: { sender: string; count: number } };

export type UnsubscribeResult = UnsubscribeActionResult | UnsubscribePreviewResult;

export type UnsubscribeRouteParams = {
	params: Promise<{ messageId: string }>;
};
