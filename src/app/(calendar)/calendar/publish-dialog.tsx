"use client";

import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PublishCard } from "./publish-card";

/** The card opens from the calendar's options menu, next to "Connect to calendar". Mounted only while open, so it loads fresh each time and a shown link is forgotten on close. */
export function PublishDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLanguage();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(560px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("calendar.publish.title")}</DialogTitle>
					<DialogDescription>{t("calendar.publish.description")}</DialogDescription>
				</DialogHeader>
				{open && <PublishCard hideTitle />}
			</DialogContent>
		</Dialog>
	);
}
