import { defaultTranslator } from "@/lib/i18n/utils";
import { saveManagedAccount } from "../utils";
import type { PasswordSaveOptions } from "./types";

export async function saveAccountPassword({ account, password, stepUpToken, setPassword, setSaving, setMessage, t = defaultTranslator }: PasswordSaveOptions) {
	if (!account) return;
	setSaving(true);
	setMessage(null);
	try {
		await saveManagedAccount({ ...account, newPassword: password }, stepUpToken);
		setPassword("");
		setMessage(t("account.password.resetDone"));
	} catch (error) {
		setMessage(error instanceof Error ? error.message : t("account.password.resetFailed"));
		throw error;
	} finally {
		setSaving(false);
	}
}
