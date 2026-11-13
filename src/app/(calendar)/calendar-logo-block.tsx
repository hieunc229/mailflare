"use client";

import { SidebarHeader } from "@/components/sidebar-header";
import { useSidebar } from "@/components/sidebar-state";

/**
 * Logo cell of the calendar header. Expanded, it ends 12px short of the left menu width plus the header gap, so the tabs start at the calendar's left edge (page padding + menu + gap). Collapsed, it shrinks to the toggle so the
 * Booking / Calendar tabs sit next to it and line up with the first day column (page padding plus the 64px hour gutter).
 */
export function CalendarLogoBlock() {
	const { minimal } = useSidebar();
	return (
		<div className="hidden shrink-0 px-3 transition-[width] duration-200 ease-in-out motion-reduce:transition-none md:block [&>div]:mb-0" style={{ width: minimal ? "4rem" : "calc(var(--sidebar-width) + 0.75rem)" }}>
			<SidebarHeader href="/inbox" />
		</div>
	);
}
