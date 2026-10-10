"use client";

import packageJson from "../../package.json";
import { useSidebar } from "./sidebar-state";
import { useShortcuts } from "./shortcuts";
import { Keyboard } from "lucide-react";
import { useLanguage } from "./language-provider";

export function SidebarFooter() {
	const { t } = useLanguage();
	const { minimal } = useSidebar();
	const { openHelpModal, shortcutsEnabled, shortcutsPreferenceLoading } = useShortcuts();
	if (minimal) return null;

  return (
    <div className="px-3 pt-3 flex flex-col gap-2">
      {shortcutsEnabled && !shortcutsPreferenceLoading && (
        <button
          type="button"
          onClick={openHelpModal}
          className="flex items-center justify-between w-full px-2.5 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200/60 rounded-lg transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <Keyboard className="w-3.5 h-3.5 text-neutral-400" />
            {t("navigation.shortcuts")}
          </span>
          <kbd className="px-1.5 py-0.5 font-mono text-[10px] bg-white border border-neutral-200 rounded text-neutral-500 shadow-2xs">
            ?
          </kbd>
        </button>
      )}
      <PoweredBy />
    </div>
  );
}

/** The "Powered by Mailflare vX" credit, shared by the mail and Drive sidebars. */
export function PoweredBy({ className = "px-1" }: { className?: string }) {
	const { t } = useLanguage();
	return (
      <p className={`${className} text-[11px] text-neutral-500`}>
        {t("navigation.poweredBy")}{" "}
        <a
          href={`https://mailflare.co/?ref=${typeof window !== "undefined" ? location.hostname : ""}&v=${packageJson.version}`}
          target="_blank"
          className="hover:underline text-neutral-500"
          rel="noreferrer"
        >
          Mailflare v{packageJson.version}
        </a>
      </p>
	);
}
