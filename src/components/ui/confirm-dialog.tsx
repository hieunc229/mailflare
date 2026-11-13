"use client";

import * as React from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ConfirmOptions, ConfirmRequest } from "./confirm-dialog-types";

// An in-app replacement for window.confirm / window.alert. It is imperative on purpose, so event
// handlers and plain helper functions can `await confirmDialog(...)` without threading a hook
// through: `if (!(await confirmDialog(message))) return;`
let enqueue: ((request: ConfirmRequest) => void) | null = null;

function normalize(input: string | ConfirmOptions): ConfirmOptions {
	return typeof input === "string" ? { message: input } : input;
}

export function confirmDialog(input: string | ConfirmOptions): Promise<boolean> {
	const options = normalize(input);
	// Before the host mounts (or outside the browser) fall back to the native dialog rather than
	// silently auto-confirming or auto-cancelling.
	if (!enqueue) return Promise.resolve(typeof window !== "undefined" && window.confirm(options.message));
	const add = enqueue;
	return new Promise((resolve) => add({ kind: "confirm", options, resolve }));
}

export function confirmDestructive(input: string | ConfirmOptions): Promise<boolean> {
	return confirmDialog({ ...normalize(input), destructive: true });
}

export async function alertDialog(input: string | ConfirmOptions): Promise<void> {
	const options = normalize(input);
	if (!enqueue) {
		if (typeof window !== "undefined") window.alert(options.message);
		return;
	}
	const add = enqueue;
	await new Promise<boolean>((resolve) => add({ kind: "alert", options, resolve }));
}

/** Mount once near the root (inside the language provider); renders the dialogs the functions above request. */
export function ConfirmDialogHost() {
	const { t } = useLanguage();
	const [queue, setQueue] = React.useState<ConfirmRequest[]>([]);
	const [typed, setTyped] = React.useState("");
	const current = queue[0];

	React.useEffect(() => {
		enqueue = (request) => setQueue((items) => [...items, request]);
		return () => {
			enqueue = null;
		};
	}, []);

	function settle(confirmed: boolean) {
		if (!current) return;
		current.resolve(confirmed);
		setTyped("");
		setQueue((items) => items.slice(1));
	}

	const options = current?.options;
	const isAlert = current?.kind === "alert";
	const needsText = Boolean(options?.requireText);
	const canConfirm = !needsText || typed.trim().toLowerCase() === options?.requireText?.trim().toLowerCase();

	return (
		<Dialog open={Boolean(current)} onOpenChange={(open) => { if (!open) settle(false); }}>
			{options && (
				<DialogContent showCloseButton={false} className="z-[400] w-[min(440px,calc(100vw-32px))]" overlayClassName="z-[400]">
					<DialogHeader>
						{options.title && <DialogTitle>{options.title}</DialogTitle>}
						{/* Radix requires a title for screen readers; the message doubles as one when there is no heading. */}
						{!options.title && <DialogTitle className="sr-only">{options.message}</DialogTitle>}
						<DialogDescription className="whitespace-pre-line text-neutral-700">{options.message}</DialogDescription>
					</DialogHeader>
					{needsText && (
						<Input
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							onKeyDown={(event) => { if (event.key === "Enter" && canConfirm) settle(true); }}
							aria-label={options.requireText}
							placeholder={options.requireText}
							autoComplete="off"
							className="mb-4"
						/>
					)}
					<div className="flex justify-end gap-2">
						{!isAlert && <Button type="button" variant="outline" onClick={() => settle(false)}>{t("common.cancel")}</Button>}
						<Button
							type="button"
							variant={options.destructive ? "destructive" : "default"}
							disabled={!canConfirm}
							onClick={() => settle(true)}
						>
							{options.confirmLabel ?? (isAlert ? t("navigation.close") : t("common.continue"))}
						</Button>
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}
