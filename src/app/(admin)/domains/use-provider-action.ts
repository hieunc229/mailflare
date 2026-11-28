import { useState } from "react";
import { useLanguage } from "@/components/language-provider";

export type ProviderActionKind = "setup" | "verify" | "test";

/** Busy, error and notice state for a provider panel's setup, verify and test buttons. */
export function useProviderAction() {
	const { t } = useLanguage();
	const [busy, setBusy] = useState<ProviderActionKind | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	// Not memoised: it must read the current `t`, so a language switch is not frozen into the message.
	async function run(kind: ProviderActionKind, action: () => Promise<void>) {
		setBusy(kind);
		setError("");
		setNotice("");
		try { await action(); } catch (err) { setError(err instanceof Error ? err.message : t("domains.requestFailed")); } finally { setBusy(null); }
	}

	return { busy, error, notice, setError, setNotice, run };
}
