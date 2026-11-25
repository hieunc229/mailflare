"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

export type MessageListShortcut = "next" | "previous" | "open" | "back";

function isMessageRoute(pathname: string): boolean {
	return /^\/(inbox|sent|drafts|archived|starred|promotions|scheduled|snoozed|spam|trash)(\/|$)/.test(pathname)
		|| pathname.startsWith("/folders/");
}

export function useMessageListShortcuts() {
	const pathname = usePathname();
	const segments = pathname.split("/").filter(Boolean);
	const hrefPrefix = segments.length > 1 && segments[0] !== "folders"
		? `/${segments[0]}`
		: segments.length > 2
			? `/${segments.slice(0, 2).join("/")}`
			: pathname;
	const router = useRouter();
	const previousPathname = useRef(pathname);

	useEffect(() => {
		const previous = previousPathname.current;
		previousPathname.current = pathname;
		if (!previous.startsWith(`${hrefPrefix}/`) || pathname !== hrefPrefix) return;
		const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
			.filter((link) => new URL(link.href).pathname.startsWith(`${hrefPrefix}/`));
		(links.find((link) => link.getAttribute("aria-current") === "true") ?? links[0])?.focus();
	}, [hrefPrefix, pathname]);

	useEffect(() => {
		const onShortcut = (event: Event) => {
			const action = (event as CustomEvent<MessageListShortcut>).detail;
			const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
				.filter((link) => new URL(link.href).pathname.startsWith(`${hrefPrefix}/`));
			const focusedIndex = links.indexOf(document.activeElement as HTMLAnchorElement);
			const activeIndex = links.findIndex((link) => link.getAttribute("aria-current") === "true");
			const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;

			if (action === "back") {
				if (!isMessageRoute(pathname)) return;
				if (pathname.startsWith(`${hrefPrefix}/`)) {
					router.push(hrefPrefix);
					return;
				}
				(links[activeIndex >= 0 ? activeIndex : 0])?.focus();
				return;
			}
			if (action === "open") {
				const link = links[currentIndex >= 0 ? currentIndex : 0];
				link?.click();
				return;
			}
			if (links.length === 0) return;
			const delta = action === "next" ? 1 : -1;
			const nextIndex = currentIndex < 0
				? (delta > 0 ? 0 : links.length - 1)
				: Math.max(0, Math.min(links.length - 1, currentIndex + delta));
			links[nextIndex]?.focus();
		};

		window.addEventListener("mailflare:message-list-shortcut", onShortcut);
		return () => window.removeEventListener("mailflare:message-list-shortcut", onShortcut);
	}, [hrefPrefix, pathname, router]);
}
