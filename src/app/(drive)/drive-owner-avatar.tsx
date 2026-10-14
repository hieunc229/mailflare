"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Tooltip } from "@/components/ui/tooltip";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import type { DriveItemDto } from "@/lib/drive/types";

/** Owner's profile picture (or a coloured initial), with "me" or their name on hover. */
export function DriveOwnerAvatar({ item }: { item: Pick<DriveItemDto, "ownerId" | "ownerName" | "ownerHasAvatar" | "role"> }) {
	const { t } = useLanguage();
	const [failed, setFailed] = useState(false);
	const label = item.role === "owner" ? t("drive.me") : item.ownerName;
	const className = "h-6 w-6 shrink-0 rounded-full";
	return (
		<Tooltip label={label}>
			{item.ownerHasAvatar && !failed
				? <img src={`/api/drive/owners/${encodeURIComponent(item.ownerId)}/avatar?variant=preview`} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} className={`${className} object-cover`} />
				: <span role="img" aria-label={label} className={`${className} flex items-center justify-center text-xs font-semibold`} style={getAvatarColorStyle(item.ownerName || item.ownerId)}>{(item.ownerName.trim().slice(0, 1) || "?").toUpperCase()}</span>}
		</Tooltip>
	);
}
