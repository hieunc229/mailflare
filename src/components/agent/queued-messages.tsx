"use client";

import { useState } from "react";
import { CornerDownRight, Pencil, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { QueuedAgentMessagesProps } from "./types";

export function QueuedAgentMessages({ messages, running, onRemove, onEdit, onSteer }: QueuedAgentMessagesProps) {
	const { t } = useLanguage();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	if (!messages.length) return null;
	return <div className="mx-auto w-full max-w-3xl px-3" aria-label={t("agent.queue.label")}><div className="max-h-48 overflow-y-auto rounded-t-2xl border border-b-0 border-blue-100 bg-blue-50/70 px-2 py-1 shadow-sm">
		{messages.map((item) => <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-sm text-neutral-700 hover:bg-white/70">
			<CornerDownRight size={15} className="shrink-0 text-neutral-400" aria-hidden="true" />
			{editingId === item.id ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (!editText.trim()) return; onEdit(item.id, editText); setEditingId(null); }}><textarea autoFocus rows={2} className="min-w-0 flex-1 resize-y rounded-lg border border-blue-200 bg-white px-2 py-1 outline-none focus:border-blue-400" value={editText} onChange={(event) => setEditText(event.target.value)} aria-label={t("agent.queue.edit")} /><button type="submit" className="shrink-0 font-medium text-blue-700" disabled={!editText.trim()}>{t("settings.autoReply.save")}</button><button type="button" className="shrink-0 text-neutral-500" onClick={() => setEditingId(null)}>{t("common.cancel")}</button></form> : <><span className="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span><button type="button" className="shrink-0 rounded-lg px-2 py-1 text-neutral-500 hover:bg-blue-100 hover:text-blue-700" onClick={() => onSteer(item.id)} title={running ? t("agent.queue.steerTitle") : t("agent.queue.sendNowTitle")}>{running ? t("agent.queue.steer") : t("agent.queue.sendNow")}</button><button type="button" className="shrink-0 rounded-lg p-1.5 text-neutral-500 hover:bg-blue-100 hover:text-blue-700" aria-label={t("agent.queue.edit")} title={t("agent.queue.edit")} onClick={() => { setEditingId(item.id); setEditText(item.text); }}><Pencil size={15} /></button><button type="button" className="shrink-0 rounded-lg p-1.5 text-neutral-500 hover:bg-red-50 hover:text-red-600" aria-label={t("agent.queue.remove")} title={t("agent.queue.remove")} onClick={() => onRemove(item.id)}><Trash2 size={15} /></button></>}
		</div>)}
	</div></div>;
}
