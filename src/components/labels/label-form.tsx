"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label as FieldLabel } from "@/components/ui/label";
import { folderColorKeys } from "@/lib/folders/color-keys";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import type { FolderColor } from "@/lib/folders/types";
import { createLabel } from "@/lib/labels/client";
import type { Label } from "@/lib/labels/types";

/** Name and colour for a new label; labels reuse the folder colours. */
export function LabelForm({ mailboxId, onCreated, autoFocus }: { mailboxId: string; onCreated: (label: Label) => void; autoFocus?: boolean }) {
	const { t } = useLanguage();
	const [name, setName] = useState("");
	const [color, setColor] = useState<FolderColor>(DEFAULT_FOLDER_COLOR);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return;
		setSaving(true);
		setError(null);
		try {
			const label = await createLabel(mailboxId, name.trim(), color);
			setName("");
			setColor(DEFAULT_FOLDER_COLOR);
			onCreated(label);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("label.createFailed"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={submit} className="space-y-4">
			<div className="space-y-2">
				<FieldLabel htmlFor={`label-name-${mailboxId}`}>{t("label.name")}</FieldLabel>
				<Input
					id={`label-name-${mailboxId}`}
					value={name}
					maxLength={80}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("label.example")}
					autoFocus={autoFocus}
				/>
			</div>
			<div className="space-y-2">
				<FieldLabel>{t("navigation.color")}</FieldLabel>
				<div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("navigation.color")}>
					{FOLDER_COLOR_OPTIONS.map((option) => (
						<button
							key={option.value}
							type="button"
							role="radio"
							aria-checked={color === option.value}
							aria-label={t(folderColorKeys[option.value])}
							title={t(folderColorKeys[option.value])}
							onClick={() => setColor(option.value)}
							className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
								color === option.value ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2" : "border-transparent"
							}`}
							style={{ backgroundColor: option.value }}
						/>
					))}
				</div>
			</div>
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
			<Button type="submit" disabled={saving || !name.trim()}>
				{saving ? t("navigation.creating") : t("navigation.createLabel")}
			</Button>
		</form>
	);
}
