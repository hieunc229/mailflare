"use client";

import { X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { HeaderSearch } from "@/components/header-search";
import { useMailSearch } from "./mail-search-context";
import { useShortcuts } from "@/components/shortcuts";

export function MailSearchInput({ mobileEnd }: { mobileEnd?: boolean }) {
	const { t } = useLanguage();
	const { input: query, setQuery } = useMailSearch();
	const { openCommandPalette, shortcutsEnabled, shortcutsPreferenceLoading } = useShortcuts();
	const showShortcutHints = shortcutsEnabled && !shortcutsPreferenceLoading;

	return (
		<HeaderSearch
			value={query}
			onChange={setQuery}
			label={t("search.mail")}
			mobileEnd={mobileEnd}
			placeholder={showShortcutHints ? t("search.mailHint") : t("search.mail")}
			inputProps={{ "data-mail-search-input": "" }}
			trailing={query ? (
				<button
					type="button"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => setQuery("")}
					className="rounded-full p-1 text-neutral-500 hover:bg-blue-100 hover:text-neutral-800"
					aria-label={t("search.clear")}
				>
					<X className="h-4 w-4" />
				</button>
			) : showShortcutHints ? (
				<button
					type="button"
					onClick={openCommandPalette}
					className="hidden sm:flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-neutral-500 bg-white/70 hover:bg-white border border-neutral-200/80 rounded-md shadow-2xs transition-colors"
					title={t("search.openPalette")}
				>
					<span className="text-[11px] font-mono">⌘K</span>
				</button>
			) : null}
		/>
	);
}
