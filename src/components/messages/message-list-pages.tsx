"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { refreshMessageViews } from "@/hooks/message-refresh";
import { useMessages } from "@/hooks/use-messages";
import type { MessageListPageProps, MessageListPagesProps } from "./message-list-pages-types";
import { ESTIMATED_ROW_HEIGHT, getActivePages, getPageHeights } from "./message-list-window-utils";

/** Scroll positions are rounded to this, so scrolling does not re-render the list on every pixel. */
const SCROLL_STEP = 200;

/** Reports the height of a rendered page, so its spacer matches once it unloads. */
function MeasuredPage({ index, onHeight, children }: { index: number; onHeight: MessageListPageProps["onHeight"]; children: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			if (element.offsetHeight > 0) onHeight(index, element.offsetHeight);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [index, onHeight]);
	return <div ref={ref} role="presentation" className="divide-y divide-neutral-100">{children}</div>;
}

/** A later page: it owns its messages, so unmounting it unloads them. */
function LoadedPage({ index, height, query, pageSize, onPageData, onHeight, renderRow }: MessageListPageProps) {
	const { t } = useLanguage();
	const { messages, isLoading, updateMessages } = useMessages(query.folder, query.mailboxId, {
		...query.filters,
		limit: pageSize,
		offset: index * pageSize,
	}, query.enabled, query.folderId);

	useEffect(() => {
		onPageData(index, { messages, updateMessages });
	}, [index, messages, updateMessages, onPageData]);
	useEffect(() => () => onPageData(index, null), [index, onPageData]);

	if (messages.length > 0) {
		return <MeasuredPage index={index} onHeight={onHeight}>{messages.map(renderRow)}</MeasuredPage>;
	}
	return (
		<div role="presentation" className="overflow-hidden" style={{ height }}>
			{isLoading ? (
				<div aria-busy="true" aria-label={t("common.loading")}>
					{Array.from({ length: Math.ceil(height / ESTIMATED_ROW_HEIGHT) }, (_, row) => (
						<div key={row} className="space-y-2 px-4 py-3" style={{ height: ESTIMATED_ROW_HEIGHT }}>
							<Skeleton className="h-4 w-1/3" />
							<Skeleton className="h-4 w-4/5" />
							<Skeleton className="h-3 w-2/3" />
						</div>
					))}
				</div>
			) : (
				<div className="px-4 py-3">
					<Button type="button" variant="outline" size="sm" onClick={() => void refreshMessageViews().catch(() => undefined)}>
						{t("webhooks.retry")}
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * The split-view list as one continuous scroll: pages load as they come near the
 * viewport and unload again once they are a few pages away.
 */
export function MessageListPages({ query, pageSize, total, firstPage, pages, onPageData, selectedIds, scrollElement, renderRow }: MessageListPagesProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({ top: 0, height: 1000 });
	const [heights, setHeights] = useState<Record<number, number>>({});

	const onHeight = useCallback((index: number, height: number) => {
		setHeights((current) => current[index] === height ? current : { ...current, [index]: height });
	}, []);

	useLayoutEffect(() => {
		const scroller = scrollElement;
		if (!scroller) return;
		function update() {
			const list = listRef.current;
			if (!scroller || !list || scroller.clientHeight === 0) return;
			const offset = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
			const top = Math.floor(Math.max(0, offset) / SCROLL_STEP) * SCROLL_STEP;
			const height = scroller.clientHeight + SCROLL_STEP;
			setViewport((current) => current.top === top && current.height === height ? current : { top, height });
		}
		update();
		scroller.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(scroller);
		return () => {
			scroller.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [scrollElement, total]);

	// A page holding a selected message stays loaded, so the selection survives scrolling.
	const pinned = new Set<number>();
	for (const [index, page] of Object.entries(pages)) {
		if (page.messages.some((message) => selectedIds.has(message.id))) pinned.add(Number(index));
	}
	const pageHeights = getPageHeights(heights, pageSize, total);
	const active = getActivePages(pageHeights, viewport.top, viewport.height, pinned);
	const sumHeights = (from: number, to: number) => pageHeights.slice(from, to).reduce((sum, height) => sum + height, 0);

	return (
		<div ref={listRef} role="presentation" className="divide-y divide-neutral-100">
			{active.map((index, position) => {
				const gap = sumHeights(position === 0 ? 0 : active[position - 1] + 1, index);
				return (
					<Fragment key={index}>
						{gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}
						{index === 0 ? (
							<MeasuredPage index={0} onHeight={onHeight}>{firstPage.map(renderRow)}</MeasuredPage>
						) : (
							<LoadedPage index={index} height={pageHeights[index]} query={query} pageSize={pageSize} onPageData={onPageData} onHeight={onHeight} renderRow={renderRow} />
						)}
					</Fragment>
				);
			})}
			<div aria-hidden="true" style={{ height: sumHeights((active.at(-1) ?? -1) + 1, pageHeights.length) }} />
		</div>
	);
}
