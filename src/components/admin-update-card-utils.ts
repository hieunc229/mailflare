import type { MigrationStatusResponse, UpdateStatusResponse, UpdateWorkflowResponse } from "./admin-update-card-types";

async function readUpdateJson<T extends { error?: string }>(response: Response): Promise<T> {
	const text = await response.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		throw new Error(plain.slice(0, 180) || response.statusText || `HTTP ${response.status}`);
	}
}

export async function getApplicationUpdateStatus(): Promise<UpdateStatusResponse> {
	const response = await fetch("/api/admin/update", { cache: "no-store" });
	const data = await readUpdateJson<UpdateStatusResponse>(response);

	if (!response.ok) {
		throw new Error(data.error ?? "Could not check for updates");
	}

	return data;
}

export async function triggerApplicationUpdate(): Promise<UpdateWorkflowResponse> {
	const response = await fetch("/api/admin/update", { method: "POST" });
	const data = await readUpdateJson<UpdateWorkflowResponse>(response);

	if (!response.ok) {
		throw new Error(data.error ?? "Could not start the update");
	}

	return data;
}

export async function getMigrationStatus(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { cache: "no-store" });
	const data = await readUpdateJson<MigrationStatusResponse>(response);
	if (!response.ok) throw new Error(data.error ?? "Could not check database migrations");
	return data;
}

export async function applyDatabaseMigrations(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { method: "POST" });
	const data = await readUpdateJson<MigrationStatusResponse>(response);
	if (!response.ok) throw new Error(data.error ?? "Could not apply database migrations");
	return data;
}

export async function saveUpdateSettings(values: { autoUpdate?: boolean; channel?: "release" | "commit" }): Promise<void> {
	const response = await fetch("/api/admin/update", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(values),
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? "Could not save the update settings");
	}
}
