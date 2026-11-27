"use client";

import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Users, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { GroupMemberView } from "../types";
import { groupsFetch, jsonInit } from "../utils";

export function MemberRow({ member, groupId }: { member: GroupMemberView; groupId: string }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const switchId = useId();
	const nameId = `${switchId}-name`;
	const noteId = `${switchId}-note`;
	const url = `/api/groups/${groupId}/members/${member.id}`;
	const remove = useMutation({
		mutationFn: () => groupsFetch(url, t("groups.removeFailed"), jsonInit("DELETE")),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
	});
	const sendAs = useMutation({
		mutationFn: (canSendAs: boolean) => groupsFetch(url, t("groups.canSendAsFailed"), jsonInit("PATCH", { canSendAs })),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
	});
	const error = (remove.isError ? remove.error : sendAs.isError ? sendAs.error : null) as Error | null;
	return <li className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 py-2">
		<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-600" aria-hidden="true">{member.kind === "user" ? <Users className="h-4 w-4" /> : <Mail className="h-4 w-4" />}</span>
		<span className="min-w-0 flex-1 basis-48">
			<span className="flex min-w-0 items-center gap-2"><span id={nameId} className="truncate text-sm font-medium text-neutral-900">{member.name}</span><span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">{member.kind === "user" ? t("groups.kindUser") : member.kind === "mailbox" ? t("groups.kindMailbox") : t("groups.kindExternal")}</span>{member.suppressed && <span title={t("groups.suppressedHint")} className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">{t("groups.suppressed")}</span>}{member.disabled && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{t("accounts.status.disabled")}</span>}</span>
			<span className="block truncate no-font-mono text-sm text-neutral-500">{member.address}</span>
			{member.kind === "user" && !member.hasPrimaryMailbox && <span id={noteId} className="block text-xs text-amber-800">{t("groups.noPrimaryMailbox")}</span>}
			{error && <span role="alert" className="block text-xs text-red-600">{error.message}</span>}
		</span>
		{member.kind === "user" && <span className="flex min-h-11 shrink-0 items-center gap-2">
			{/* A real label: the whole phrase toggles the switch, which gives touch a full-height target. */}
			<label id={`${switchId}-label`} htmlFor={switchId} className="cursor-pointer text-sm text-neutral-700">{t("groups.canSendAs")}</label>
			{/* Named by the action and the member, so a list of these switches is not a list of identical names. */}
			<Switch id={switchId} aria-labelledby={`${switchId}-label ${nameId}`} aria-describedby={member.hasPrimaryMailbox ? undefined : noteId} checked={member.canSendAs} disabled={sendAs.isPending} onCheckedChange={(next) => sendAs.mutate(next)} />
		</span>}
		<Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()} aria-label={t("groups.removeMember", { name: member.name })} className="h-9 w-9 shrink-0 p-0 pointer-coarse:h-11 pointer-coarse:w-11"><X className="h-4 w-4" /></Button>
	</li>;
}
