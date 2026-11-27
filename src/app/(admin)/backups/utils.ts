import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import type { BackupItem, BackupsResponse, BackupSettings } from "./types";
import { prepareUpload } from "@/lib/uploads/client";

export const WEEKDAYS = [
	{ value: 0, labelKey: "weekday.0" as const },
	{ value: 1, labelKey: "weekday.1" as const },
	{ value: 2, labelKey: "weekday.2" as const },
	{ value: 3, labelKey: "weekday.3" as const },
	{ value: 4, labelKey: "weekday.4" as const },
	{ value: 5, labelKey: "weekday.5" as const },
	{ value: 6, labelKey: "weekday.6" as const },
];

export async function fetchBackups(): Promise<BackupsResponse> {
	const response = await authFetch("/api/backups");
	const data = (await response.json()) as BackupsResponse & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to load backups");
	return data;
}

export async function saveBackupSettings(settings: BackupSettings): Promise<void> {
	const response = await authFetch("/api/backups", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to save backup settings");
}

export async function startBackup(): Promise<void> {
	const response = await authFetch("/api/backups", { method: "POST" });
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to run backup");
}

export async function removeBackup(id: string): Promise<void> {
	const response = await authFetch(`/api/backups/${id}`, { method: "DELETE" });
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to delete backup");
}

export async function restoreBackup(file: File): Promise<void> {
	const form = new FormData();
	form.set("backup", file);
	const upload = await prepareUpload(form);
	const response = await authFetch("/api/backups/restore", { method: "POST", ...upload });
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to restore backup");
}

export async function downloadBackup(backup: BackupItem): Promise<void> {
	const response = await authFetch(`/api/backups/${backup.id}/download`);
	if (!response.ok) {
		const data = (await response.json()) as { error?: string };
		throw new Error(data.error ?? "Failed to download backup");
	}
	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = backup.filename ?? `${backup.id}.sql`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export function formatBackupDate(value: string | null): string {
	if (!value) return "-";
	return formatUserDate(value, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export function formatBackupSize(value: number | null): string {
	if (value === null) return "-";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function getStatusClass(status: BackupItem["status"]): string {
	if (status === "completed") return "border-green-200 bg-green-50 text-green-700";
	if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
	if (status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
	return "border-amber-200 bg-amber-50 text-amber-700";
}
