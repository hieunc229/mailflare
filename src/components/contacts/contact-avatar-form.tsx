"use client";

import { useRef, useState } from "react";
import { Camera, LoaderCircle } from "@/components/icons";
import { dispatchContactAvatarChanged } from "@/lib/contacts/avatar-client";
import { normalizeEmailAddress } from "@/lib/email/address";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/components/language-provider";
import { ContactAvatar } from "./contact-avatar";
import type { ContactAvatarFormProps } from "./contact-avatar-form-types";
import {
	CONTACT_AVATAR_ACCEPT,
	removeContactAvatar,
	uploadContactAvatar,
	validateContactAvatar,
} from "./contact-avatar-form-utils";

export function ContactAvatarForm({
	mailboxId,
	address,
	name,
	hasAvatar,
	onAvatarChange,
}: ContactAvatarFormProps) {
	const { t } = useLanguage();
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0] ?? null;
		event.target.value = "";
		if (!file) return;
		const validationError = validateContactAvatar(file);
		if (validationError) {
			setStatus(validationError);
			return;
		}

		setBusy(true);
		setStatus(null);
		try {
			await uploadContactAvatar(mailboxId, address, file);
			onAvatarChange(true);
			dispatchContactAvatarChanged({ email: normalizeEmailAddress(address), hasAvatar: true });
		} catch (error) {
			setStatus(error instanceof Error ? error.message : t("avatar.uploadFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function onRemove() {
		setBusy(true);
		setStatus(null);
		try {
			await removeContactAvatar(mailboxId, address);
			onAvatarChange(false);
			dispatchContactAvatarChanged({ email: normalizeEmailAddress(address), hasAvatar: false });
		} catch (error) {
			setStatus(error instanceof Error ? error.message : t("avatar.removeFailed"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col items-start gap-2">
			<Input ref={inputRef} type="file" accept={CONTACT_AVATAR_ACCEPT} className="hidden" onChange={onPick} />
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					disabled={busy}
					className="group relative h-14 w-14 overflow-hidden rounded-full outline-none ring-blue-500 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-wait"
					aria-label={hasAvatar ? t("avatar.change", { name }) : t("avatar.upload", { name })}
				>
					<ContactAvatar
						mailboxId={mailboxId}
						address={address}
						name={name}
						hasManagedAvatar={hasAvatar}
						className="h-14 w-14 text-lg"
					/>
					<span className="absolute inset-0 flex items-center justify-center bg-neutral-950/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
						{busy ? <LoaderCircle className="h-5 w-5 animate-spin text-white" /> : <Camera className="h-5 w-5 text-white" />}
					</span>
				</button>
				<div>
					<p className="text-sm font-medium text-neutral-900">{t("avatar.title")}</p>
					<p className="text-xs text-neutral-500">{t("avatar.contactHint")}</p>
					{hasAvatar && (
						<button type="button" onClick={() => void onRemove()} disabled={busy} className="mt-1 text-xs font-medium text-blue-600 hover:underline disabled:text-neutral-400">
							{t("avatar.remove")}
						</button>
					)}
				</div>
			</div>
			{status && <p role="alert" className="text-xs text-red-600">{status}</p>}
		</div>
	);
}
