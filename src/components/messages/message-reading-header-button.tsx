"use client";

import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessageListVisibility } from "./message-list-visibility";
import { ArrowLeft02 } from "@/components/icons";

/** Back to the list, shown when the reader has the whole width to itself. */
export function MessageReadingHeaderButton() {
	const { t } = useLanguage();
	const router = useRouter();
	const { singleColumn, backHref, backLabel } = useMessageListVisibility();
	if (!singleColumn) return null;
	const label = t("message.nav.backTo", { folder: backLabel });

	return (
		<Tooltip label={label} className="inline-flex">
			<Button
				type="button"
				variant="round"
				size="round"
				className="z-10 text-neutral-600 hover:text-neutral-900"
				onClick={() => router.push(backHref)}
				aria-label={label}
			>
				<ArrowLeft02 size={16} />
			</Button>
		</Tooltip>
	);
}
