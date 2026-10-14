import { useEffect } from "react";
import type { RefObject } from "react";
import { getSheetViewportStyle } from "./sheet-viewport-utils";

// Mobile browsers keep `position: fixed` anchored to the layout viewport, so the on-screen keyboard or a collapsing
// address bar would hide the sheet's send toolbar. Track the visual viewport and publish the result as CSS variables.
export function useSheetViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
	useEffect(() => {
		const viewport = window.visualViewport;
		const element = ref.current;
		if (!enabled || !viewport || !element) return;
		function update() {
			if (!viewport || !element) return;
			const style = getSheetViewportStyle(window.innerHeight, viewport.height, viewport.offsetTop);
			element.style.setProperty("--sheet-height", style.height);
			element.style.setProperty("--sheet-bottom", style.bottom);
			element.style.setProperty("--sheet-pad", style.padding);
		}
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
		};
	}, [ref, enabled]);
}
