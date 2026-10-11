/**
 * Opening the keyboard on iOS without Safari panning the page.
 *
 * iOS only raises the keyboard for a focus() made during a tap. If a sheet focuses its first field
 * while it is still sliding up from below the screen, Safari decides the field is under the
 * keyboard and pans the whole page up to reveal it: the stacked card behind disappears and the
 * sheet ratchets up in steps. Instead, the tap that opens the sheet focuses an invisible field
 * pinned to the top of the screen (nothing to pan to), which raises the keyboard; once the sheet
 * has landed, focus moves to the real field and the keyboard simply stays up.
 */

const PROXY_ID = "mf-keyboard-proxy";

function isTouchPhone() {
	return typeof window !== "undefined" && window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches;
}

/** Call synchronously from the tap that opens a phone sheet. */
export function primePhoneKeyboard() {
	if (!isTouchPhone()) return;
	let proxy = document.getElementById(PROXY_ID) as HTMLInputElement | null;
	if (!proxy) {
		proxy = document.createElement("input");
		proxy.id = PROXY_ID;
		proxy.type = "text";
		proxy.tabIndex = -1;
		proxy.setAttribute("aria-hidden", "true");
		proxy.setAttribute("autocomplete", "off");
		// 16px stops iOS zooming; top 0 means there is nothing to scroll into view.
		proxy.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none;";
		proxy.addEventListener("blur", () => proxy?.remove(), { once: true });
		document.body.appendChild(proxy);
	}
	proxy.focus({ preventScroll: true });
}

/** Moves focus (and the open keyboard) to the sheet's real field without scrolling. */
export function handOffPhoneKeyboard(target: HTMLElement | null) {
	if (target) target.focus({ preventScroll: true });
	document.getElementById(PROXY_ID)?.remove();
}

/** True while a primed keyboard is waiting for its sheet. */
export function phoneKeyboardPrimed() {
	return typeof document !== "undefined" && document.activeElement?.id === PROXY_ID;
}

/** Focuses a contentEditable with the caret at the end of its text, as tapping below the text would. */
export function focusEditableEnd(element: HTMLElement | null | undefined) {
	if (!element) return;
	element.focus({ preventScroll: true });
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.selectNodeContents(element);
	range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
}
