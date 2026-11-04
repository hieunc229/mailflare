import type { TranslationKey } from "@/lib/i18n/types";
import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import type { LucideIcon } from "@/components/icons";

export interface MessageAttachmentCardProps {
	attachment: MessageAttachment;
	messageId: string;
	onPreview: (attachment: MessageAttachment) => void;
}

export type AttachmentVisual = {
	icon: LucideIcon;
	iconClassName: string;
	labelKey: TranslationKey;
	thumbnail: "image" | "video" | null;
};
