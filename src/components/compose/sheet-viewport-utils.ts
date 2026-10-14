const KEYBOARD_THRESHOLD_PX = 120;

export function getSheetViewportStyle(layoutHeight: number, visualHeight: number, visualOffsetTop: number) {
	const keyboardOpen = layoutHeight - visualHeight > KEYBOARD_THRESHOLD_PX;
	const bottom = Math.max(0, layoutHeight - visualHeight - visualOffsetTop);
	return {
		height: `${Math.round(visualHeight)}px`,
		bottom: `${Math.round(bottom)}px`,
		padding: keyboardOpen ? "0.5rem" : "max(env(safe-area-inset-bottom), 1rem)",
	};
}
