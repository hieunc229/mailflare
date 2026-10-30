import type { Dispatch, SetStateAction } from "react";
import type { Translator } from "@/lib/i18n/utils";
import type { ManagedAccount } from "../types";

export type PasswordSaveOptions = {
	account: ManagedAccount | null;
	password: string;
	stepUpToken: string;
	setPassword: Dispatch<SetStateAction<string>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	setMessage: Dispatch<SetStateAction<string | null>>;
	t?: Translator;
};
