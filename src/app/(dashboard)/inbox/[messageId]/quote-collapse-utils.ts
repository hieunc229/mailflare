export function collapseQuotedEmailHtml(html: string | null, preserveLeadingQuote = false, toggleLabel = "Toggle quoted email"): string | null {
	if (!html) return null;
	const template = window.document.createElement("template");
	template.innerHTML = html;
	const document = { body: template.content, createElement: window.document.createElement.bind(window.document) };

	let skippedLeading = false;
	for (const blockquote of Array.from(document.body.querySelectorAll("blockquote"))) {
		const introduction = blockquote.previousElementSibling;
		if (
			!(introduction instanceof HTMLElement) ||
			!/^On\b[\s\S]*\bwrote:\s*$/i.test(introduction.textContent?.trim() ?? "")
		) continue;
		// The outer toggle already folded this quote, so its first attribution
		// stays open. It need not be the first element: sanitising can leave
		// a leading <br> or wrapper before it.
		if (preserveLeadingQuote && !skippedLeading) {
			skippedLeading = true;
			continue;
		}

		const details = document.createElement("details");
		details.className = "email-quote-toggle";
		const summary = document.createElement("summary");
		summary.setAttribute("aria-label", toggleLabel);
		summary.setAttribute("title", toggleLabel);
		const content = document.createElement("div");
		content.className = "email-quote-content";
		introduction.parentNode?.insertBefore(details, introduction);
		content.appendChild(introduction);
		content.appendChild(blockquote);
		details.appendChild(summary);
		details.appendChild(content);
	}

	return template.innerHTML;
}
