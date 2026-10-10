"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import remarkGfm from "remark-gfm";
import { ChevronDown, Clock3 } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import type { AgentTurnProps } from "./types";
import { agentDraftIdFromHref, formatAgentDuration } from "./utils";
import { AgentDraftActions, AgentPendingActions, AgentToolActivity } from "./tool-activity";

export function AgentTurnView({ turn, draftActions, onOpenDraft, onApproveDraft, onApproveAction, approvingId }: AgentTurnProps) {
	const { t } = useLanguage();
	const [workOpen, setWorkOpen] = useState(turn.running);
	const [prevRunning, setPrevRunning] = useState(turn.running);
	if (turn.running !== prevRunning) {
		setPrevRunning(turn.running);
		setWorkOpen(turn.running);
	}
	const turnDraftActions = draftActions.filter((action) => turn.activity.some((item) => item.id === action.messageId));
	const workContent = <div className="mt-2 space-y-2 text-xs">
		{turn.activity.length ? turn.activity.map((item) => item.role === "reasoning" ? <p key={item.id} className="whitespace-pre-wrap break-words text-xs text-neutral-600 pl-5">{item.content}</p> : <AgentToolActivity key={item.id} item={item} forceOpen={turn.running} />) : <p className="text-neutral-500">{turn.running ? t("agent.turn.waiting") : t("agent.turn.noDetails")}</p>}
	</div>;
	return <div className="space-y-3 py-2">
		{turn.user && <div className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-blue-100/65 px-4 py-3 text-sm leading-relaxed text-black">{turn.user.content}</div>}
		{(turn.assistant || turn.activity.length > 0) && <div className="space-y-3">
			{turn.running ? turn.activity.length > 0 && <div className="text-neutral-500">{workContent}</div> : <details open={workOpen} onToggle={(event) => setWorkOpen(event.currentTarget.open)} className="group/process text-neutral-500"><summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 py-1 [&::-webkit-details-marker]:hidden"><Clock3 size={13} className="text-neutral-400" aria-hidden="true" /><span>{turn.durationMs !== null ? t("agent.turn.workedFor", { duration: formatAgentDuration(turn.durationMs) }) : t("agent.turn.workDetails")}</span><ChevronDown size={13} className="transition-transform group-open/process:rotate-180" aria-hidden="true" /></summary>{workContent}</details>}
			{turn.assistant?.content && <div className="break-words text-sm leading-relaxed text-neutral-900 [&_a]:text-blue-700 [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3 message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ href, children }) => { const draftId = agentDraftIdFromHref(href); return draftId ? <Link href={`/drafts/${encodeURIComponent(draftId)}`}>{children}</Link> : href?.startsWith("/") && !href.startsWith("//") ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>; } }}>{turn.assistant.content}</ReactMarkdown></div>}
			{turnDraftActions.map((action) => <AgentDraftActions key={action.draftId} action={action} onOpenDraft={onOpenDraft} onApproveDraft={onApproveDraft} approvingId={approvingId} />)}
			{turn.activity.filter((item) => item.role === "tool").map((item) => <AgentPendingActions key={`${item.id}:actions`} item={item} onApproveAction={onApproveAction} approvingId={approvingId} />)}
		</div>}
	</div>;
}
