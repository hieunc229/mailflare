import PostalMime from "postal-mime";

export type ParsedEmail = {
	subject: string | null;
	text: string | null;
	html: string | null;
	messageId: string | null;
};

export async function parseRawMime(raw: ArrayBuffer): Promise<ParsedEmail> {
	const email = await PostalMime.parse(raw);
	return {
		subject: email.subject ?? null,
		text: email.text ?? null,
		html: email.html ?? null,
		messageId: email.messageId ?? null,
	};
}

export function buildSnippet(text: string | null, html: string | null, max = 200): string {
	const source = text ?? html?.replace(/<[^>]+>/g, " ") ?? "";
	return source.replace(/\s+/g, " ").trim().slice(0, max);
}
