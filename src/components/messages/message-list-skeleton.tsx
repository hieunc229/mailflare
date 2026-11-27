"use client";

import { useLanguage } from "@/components/language-provider";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageListSkeletonProps } from "./message-list-skeleton-types";

/** Bar widths per placeholder row, varied so the rows read like different emails. */
const ROWS = [
	{ sender: "w-32", subject: "w-3/5", preview: "w-5/6", line: "w-4/5" },
	{ sender: "w-24", subject: "w-4/5", preview: "w-2/3", line: "w-3/5" },
	{ sender: "w-36", subject: "w-2/5", preview: "w-3/4", line: "w-11/12" },
	{ sender: "w-20", subject: "w-2/3", preview: "w-1/2", line: "w-1/2" },
	{ sender: "w-28", subject: "w-1/2", preview: "w-4/5", line: "w-2/3" },
];

/** Placeholder rows matching the compact and full-width message list layouts. */
export function MessageListSkeleton({ compact }: MessageListSkeletonProps) {
	const { t } = useLanguage();
	return (
		<div role="status" aria-label={t("common.loading")} className="divide-y divide-neutral-100">
			{ROWS.map((row, index) => compact ? (
				<div key={index} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-l-2 border-l-transparent px-4 py-3">
					<Skeleton className="mt-1 h-4 w-4" />
					<div className="min-w-0">
						<div className="flex h-6 items-center justify-between gap-3">
							<Skeleton className={`h-4 ${row.sender}`} />
							<Skeleton className="h-3 w-10 shrink-0" />
						</div>
						<div className="mt-1 flex h-5 items-center">
							<Skeleton className={`h-3.5 ${row.subject}`} />
						</div>
						<div className="mt-0.5 flex h-5 items-center">
							<Skeleton className={`h-3 ${row.preview}`} />
						</div>
					</div>
				</div>
			) : (
				<div key={index} className="grid min-h-12 grid-cols-[24px_32px_minmax(160px,80px)_1fr_auto] items-center gap-3 px-6">
					<Skeleton className="h-4 w-4" />
					<Skeleton className="h-4 w-4" />
					<Skeleton className={`h-3.5 ${row.sender}`} />
					<div className="min-w-0 pl-11">
						<Skeleton className={`h-3.5 ${row.line}`} />
					</div>
					<div className="flex min-w-[96px] justify-end">
						<Skeleton className="h-3 w-12" />
					</div>
				</div>
			))}
		</div>
	);
}
