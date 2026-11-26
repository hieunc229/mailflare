import type { MigrationStatusResponse, UpdateStatusResponse, UpdateWorkflowResponse } from "./admin-update-card-types";

export async function getApplicationUpdateStatus(): Promise<UpdateStatusResponse> {
	const response = await fetch("/api/admin/update", { cache: "no-store" });
	const data = (await response.json()) as UpdateStatusResponse;

	if (!response.ok) {
		throw new Error(data.error ?? "Could not check for updates");
	}

	return data;
}

export async function triggerApplicationUpdate(): Promise<UpdateWorkflowResponse> {
	const response = await fetch("/api/admin/update", { method: "POST" });
	const data = (await response.json()) as UpdateWorkflowResponse;

	if (!response.ok) {
		throw new Error(data.error ?? "Could not start the update");
	}

	return data;
}

export async function getMigrationStatus(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { cache: "no-store" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not check database migrations");
	return data;
}

export async function applyDatabaseMigrations(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { method: "POST" });
	const data = (await response.json()) as MigrationStatusResponse;
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
