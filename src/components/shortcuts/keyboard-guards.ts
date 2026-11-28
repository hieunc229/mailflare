export function isTypingInInput(target: EventTarget | null): boolean {
	if (!target || !(target instanceof HTMLElement)) return false;
	const tagName = target.tagName.toUpperCase();
	const isInputOrTextarea = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT"
		|| target.closest('[role="combobox"]') !== null;
	const isContentEditable = target.isContentEditable || target.getAttribute("contenteditable") === "true";
	const isTextbox = target.getAttribute("role") === "textbox" || target.closest('[role="textbox"]') !== null;
	return isInputOrTextarea || isContentEditable || isTextbox;
}

export function hasOpenDialogOrMenu(doc: Document): boolean {
	return doc.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;
}
