"use client";

import clsx from "clsx";
import { ChevronUp } from "@/components/icons";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useIsMobile } from "./sidebar-mobile-utils";

type SectionNavSheetProps = {
	label: string;
	title: string;
	children: ReactNode;
	className?: string;
};

// Inline column from md up; on phones a bottom sheet opened from a floating pill showing the current section.
export function SectionNavSheet({ label, title, children, className }: SectionNavSheetProps) {
	const mobile = useIsMobile();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const hidden = mobile && !open;

	useEffect(() => {
		setOpen(false);
	}, [pathname, mobile]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open]);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-haspopup="dialog"
				aria-expanded={open}
				className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg md:hidden"
			>
				<span className="max-w-[60vw] truncate">{label}</span>
				<ChevronUp size={16} aria-hidden="true" />
			</button>
			<div
				onClick={() => setOpen(false)}
				aria-hidden="true"
				className={clsx("fixed inset-0 z-[100] bg-black/40 transition-opacity duration-200 ease-out motion-reduce:transition-none md:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")}
			/>
			<aside
				role={mobile ? "dialog" : undefined}
				aria-label={title}
				aria-hidden={hidden}
				inert={hidden}
				className={clsx(
					"fixed inset-x-0 bottom-0 z-[110] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-300 ease-out motion-reduce:transition-none",
					"md:static md:z-auto md:max-h-none md:translate-y-0 md:overflow-visible md:rounded-none md:bg-transparent md:pb-0 md:shadow-none",
					open ? "translate-y-0" : "translate-y-full",
					className,
				)}
			>
				<div className="flex justify-center pt-3 md:hidden" onClick={() => setOpen(false)}>
					<span className="h-1.5 w-10 rounded-full bg-neutral-300" />
				</div>
				{children}
			</aside>
		</>
	);
}
