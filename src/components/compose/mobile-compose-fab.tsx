"use client";

import { Pencil } from "lucide-react";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "./compose-context";
import { primePhoneKeyboard } from "./phone-keyboard-utils";

/** Gmail's floating Compose button, on phones only, over mail lists and messages. */
export function MobileComposeFab() {
	const { t } = useLanguage();
	const { open, openComposer } = useCompose();
	const pathname = usePathname();
	if (open || pathname.startsWith("/compose") || pathname.startsWith("/sequences/")) return null;
	return (
		<button
			type="button"
			onClick={() => { primePhoneKeyboard(); openComposer(); }}
			className="fixed bottom-24 right-4 z-30 flex h-14 items-center gap-3 rounded-2xl bg-blue-100 pl-4 pr-5 text-[15px] font-medium text-blue-950 shadow-[0_2px_6px_rgba(0,0,0,0.15),0_6px_16px_rgba(0,0,0,0.12)] active:bg-blue-200 md:hidden"
		>
			<Pencil className="h-5 w-5" aria-hidden />
			{t("navigation.compose")}
		</button>
	);
}
