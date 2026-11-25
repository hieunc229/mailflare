/**
 * Copies text. `navigator.clipboard` only exists in secure contexts, so a self-hosted install on plain
 * http (or a denied permission) falls back to a selected temporary field and `execCommand("copy")`.
 * Resolves false when nothing worked, so the caller can ask the user to copy by hand.
 */
export async function copyText(value: string): Promise<boolean> {
	try {
		if (navigator.clipboard) {
			await navigator.clipboard.writeText(value);
			return true;
		}
	} catch {
		// Fall through to the selection fallback.
	}
	if (typeof document === "undefined") return false;
	const previous = document.activeElement as HTMLElement | null;
	const field = document.createElement("textarea");
	field.value = value;
	field.setAttribute("readonly", "");
	field.setAttribute("aria-hidden", "true");
	Object.assign(field.style, { position: "fixed", top: "0", insetInlineStart: "0", opacity: "0" });
	document.body.appendChild(field);
	try {
		field.select();
		field.setSelectionRange(0, value.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(field);
		previous?.focus?.({ preventScroll: true });
	}
}
