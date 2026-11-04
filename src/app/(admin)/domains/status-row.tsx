import type { ReactNode } from "react";
import { AlertTriangle, Check } from "@/components/icons";

export const ROW_GRID = "grid gap-3 rounded-xl px-4 py-3 text-sm sm:grid-cols-[auto_minmax(8rem,14rem)_minmax(0,1fr)_auto] sm:items-start";

export function StatusBadge({ ok, tone = "red" }: { ok: boolean; tone?: "red" | "neutral" }) {
	if (ok) {
		return (
			<span className="flex h-7 w-7 items-center justify-center rounded-full bg-green-600 text-white">
				<Check className="h-4 w-4" />
			</span>
		);
	}
	return (
		<span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/70">
			<AlertTriangle className={`h-4 w-4 ${tone === "red" ? "text-red-600" : "text-neutral-400"}`} />
		</span>
	);
}

/** An icon-left status line shared by the domain setup and sending setup lists. */
export function StatusRow({ ok, title, hint, children, action }: { ok: boolean; title: string; hint: string; children?: ReactNode; action?: ReactNode }) {
	return (
		<li className={`${ROW_GRID} ${ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
			<StatusBadge ok={ok} />
			<span className="min-w-0">
				<span className="block font-medium text-neutral-900">{title}</span>
				<span className="block text-xs text-neutral-500">{hint}</span>
			</span>
			<span className="min-w-0 break-words text-neutral-500">{children}</span>
			{action && <span className="flex flex-wrap items-center gap-2">{action}</span>}
		</li>
	);
}
