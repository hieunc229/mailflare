"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Upload } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { ImportMessagesProps, ImportMessagesResult } from "./import-messages-types";
import { importMessageFiles } from "./import-messages-utils";

export function ImportMessages({ destination, sourceLabel }: ImportMessagesProps) {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const [files, setFiles] = useState<File[]>([]);
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<ImportMessagesResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!selectedMailbox?.id || files.length === 0) return;

		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const nextResult = await importMessageFiles(selectedMailbox.id, files, destination);
			setResult(nextResult);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("import.failed"));
		} finally {
			setLoading(false);
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Upload className="h-4 w-4" />
					{t("import.title")}
				</CardTitle>
				<CardDescription>
					{t("import.description", { source: sourceLabel })}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="mail-import">{t("import.filesLabel")}</Label>
						<Input
							id="mail-import"
							type="file"
							accept=".eml,.mbox,.mbx,message/rfc822,application/mbox"
							multiple
							onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
							className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm shadow-neutral-200/50 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium"
						/>
						<p className="text-xs leading-5 text-neutral-500">
							{t("import.limits")}
						</p>
					</div>

					<Button type="submit" disabled={!selectedMailbox || files.length === 0 || loading}>
						{loading ? t("import.importing") : t("import.submit")}
					</Button>

					{result?.job && (
						<p className="rounded-lg border border-green-100 bg-green-50 px-4 py-3 text-sm text-green-700">
							{t("importJobs.started")}
						</p>
					)}

					{error && (
						<p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
							{error}
						</p>
					)}
				</form>
			</CardContent>
		</Card>
	);
}
