"use client";

import { useState, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Button } from "./button";
import { Input } from "./input";

type Request = { id: number; message: string; mode: "confirm" | "prompt" | "alert"; finish: (value: string | boolean | null) => void; focus: HTMLElement | null };
const listeners = new Set<() => void>();
let queue: Request[] = [];
let nextId = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => queue[0] ?? null;
const serverSnapshot = () => null;
const publish = () => listeners.forEach((listener) => listener());

function request(message: string, mode: Request["mode"]): Promise<string | boolean | null> {
	if (typeof document === "undefined" || listeners.size === 0) return Promise.resolve(mode === "prompt" ? null : false);
	return new Promise((finish) => {
		queue = [...queue, { id: ++nextId, message, mode, finish, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null }];
		publish();
	});
}

export async function confirmAction(message: string): Promise<boolean> { return (await request(message, "confirm")) === true; }
export async function promptAction(message: string): Promise<string | null> {
	const value = await request(message, "prompt");
	return typeof value === "string" ? value : null;
}
export function notifyAction(message: string): void { void request(message, "alert"); }

function InstallationDialog({ item }: { item: Request }) {
	const { t } = useLanguage();
	const [value, setValue] = useState("");
	const finish = (answer: string | boolean | null) => {
		if (queue[0] !== item) return;
		queue = queue.slice(1);
		item.finish(answer);
		publish();
	};
	return <Dialog open onOpenChange={(open) => { if (!open) finish(item.mode === "prompt" ? null : false); }}>
		<DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); if (!queue.length && item.focus?.isConnected) item.focus.focus(); }}>
			<DialogTitle>{t("common.continue")}</DialogTitle>
			<DialogDescription className="mb-5 mt-3 whitespace-pre-wrap text-neutral-700">{item.message}</DialogDescription>
			<form onSubmit={(event) => { event.preventDefault(); finish(item.mode === "prompt" ? value : true); }}>
				{item.mode === "prompt" && <Input aria-label={item.message} autoFocus value={value} onChange={(event) => setValue(event.target.value)} className="mb-5" />}
				<div className="flex justify-end gap-2">
					{item.mode !== "alert" && <Button type="button" variant="outline" autoFocus={item.mode === "confirm"} onClick={() => finish(item.mode === "prompt" ? null : false)}>{t("common.cancel")}</Button>}
					<Button type="submit">{t("common.continue")}</Button>
				</div>
			</form>
		</DialogContent>
	</Dialog>;
}

export function InstallationDialogs() {
	const item = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
	return item ? <InstallationDialog key={item.id} item={item} /> : null;
}
