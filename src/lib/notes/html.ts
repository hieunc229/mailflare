/**
 * Notes are stored as an HTML string from the note editor. These helpers are
 * pure so the API, the MCP tool and the browser agree on what counts as a note.
 * Markup is not trusted here: the reader sanitizes it again before display.
 */

const TAG_PATTERN = /<\/?[a-z][a-z0-9]*[\s>/]/i;

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text as note HTML: escaped, with line breaks kept. */
export function plainTextToNoteHtml(text: string): string {
	const value = text.replace(/\r\n?/g, "\n").trim();
	return value ? `<div>${escapeHtml(value).replace(/\n/g, "<br>")}</div>` : "";
}

/** Notes written before the rich editor, or sent as plain text, hold no markup. */
export function noteBodyToHtml(body: string): string {
	return TAG_PATTERN.test(body) ? body : plainTextToNoteHtml(body);
}

/** Whether the markup says anything: visible text, once tags and spaces are gone. */
export function noteHasContent(html: string): boolean {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;|&#160;/gi, " ")
		.trim().length > 0;
}
