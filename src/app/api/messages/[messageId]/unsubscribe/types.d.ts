export type UnsubscribeMethod = "one-click" | "mailto" | "link";

export type UnsubscribeResult =
	| { ok: true; method: "one-click" }
	| { ok: true; method: "mailto" }
	| { ok: true; method: "link"; url: string };

export type MailtoUnsubscribeTarget = {
	to: string;
	subject: string;
	text: string;
};

export type UnsubscribeRouteParams = {
	params: Promise<{ messageId: string }>;
};
