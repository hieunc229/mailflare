export function createsDriveItemInCurrentListing(view: string, canWrite: boolean, folder: string | null): boolean {
	return canWrite && (view === "my" || (view === "shared" && folder !== null));
}

export function newDriveItemParent(view: string, canWrite: boolean, folder: string | null): string | null {
	return createsDriveItemInCurrentListing(view, canWrite, folder) ? folder : null;
}
