"use client";

import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Forward, MoreVertical, Note, Reply, ShieldAlert, ShieldCheck, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import type { EmptyMessagePaneProps } from "./types";

/** The reader column before a message is opened: the reader's header, disabled, over a placeholder. */
export function EmptyMessagePane({ folder }: EmptyMessagePaneProps) {
	const { t } = useLanguage();
	const received = folder !== "sent" && folder !== "scheduled";
	const actions = [
		folder === "archived"
			? { label: t("common.unarchive"), Icon: ArchiveRestore }
			: { label: t("common.archive"), Icon: Archive },
		...(received ? [folder === "spam"
			? { label: t("common.notSpam"), Icon: ShieldCheck }
			: { label: t("common.reportSpam"), Icon: ShieldAlert }] : []),
		{ label: folder === "trash" || folder === "spam" ? t("common.deleteForever") : t("actions.moveToTrash"), Icon: Trash2 },
	];
	const secondary = [
		{ label: t("note.add"), Icon: Note },
		{ label: t("message.reply"), Icon: Reply },
		{ label: t("message.forward"), Icon: Forward },
		{ label: t("common.moreActions"), Icon: MoreVertical },
	];
	const renderButton = ({ label, Icon }: { label: string; Icon: typeof Archive }) => (
		<Button key={label} type="button" variant="round" size="round" aria-label={label} disabled>
			<Icon size={16} />
		</Button>
	);

	return (
		<>
			<div className="flex h-12 shrink-0 items-center gap-3 border-b border-transparent px-2 py-2">
				<div className="ml-4 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-neutral-600">
					{actions.map(renderButton)}
					<span className="mx-2 h-5 w-px shrink-0 bg-gray-200/60" aria-hidden="true" />
					{secondary.map(renderButton)}
				</div>
				<div className="flex shrink-0 items-center gap-2 text-neutral-500">
					{renderButton({ label: t("message.nav.newer"), Icon: ChevronLeft })}
					{renderButton({ label: t("message.nav.older"), Icon: ChevronRight })}
				</div>
			</div>
			<div className="flex min-h-0 flex-1 items-center justify-center px-6">
				<p className="text-sm text-neutral-500">{t("message.noneSelected")}</p>
			</div>
		</>
	);
}
