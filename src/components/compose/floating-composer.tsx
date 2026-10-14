"use client";

import { MailPlus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { ComposeForm } from "@/components/compose/compose-form";
import { useCompose } from "@/components/compose/compose-context";
import { useSidebar } from "@/components/sidebar-state";
import { useLanguage } from "@/components/language-provider";

/** `showButton` adds the phone Compose button; only the dashboard pages (mail) pass it. */
export function FloatingComposer({ showButton = false }: { showButton?: boolean }) {
	const { open, draftId, openComposer, closeComposer, notice } = useCompose();
	const pathname = usePathname();
	const router = useRouter();
	const { t } = useLanguage();
	const { mobileOpen } = useSidebar();
	return (
		<>
			{showButton && !open && !mobileOpen && (
				<button
					type="button"
					onClick={openComposer}
					aria-label={t("navigation.compose")}
					className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex h-12 items-center gap-3 rounded-2xl bg-blue-100 px-5 text-base font-medium text-blue-950 shadow-sm transition-colors hover:bg-blue-200 active:bg-blue-200 md:hidden"
				>
					<MailPlus size={19} />
					{t("navigation.compose")}
				</button>
			)}
			{notice && (
				<div role="status" className="fixed right-6 top-6 z-[60] rounded-lg bg-green-600 px-4 py-3 text-sm font-medium text-white shadow-lg">
					{notice}
				</div>
			)}
			{open && <ComposeForm key={draftId ?? "new"} mode="popup" draftIdToLoad={draftId} onClose={() => {
				closeComposer();
				if (/^\/drafts\/[^/]+\/?$/.test(pathname)) router.replace("/drafts");
			}} />}
		</>
	);
}
