import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import type { DriveCrumb, DriveItemDto, DriveRole } from "@/lib/drive/types";

export type DriveListing = { items: DriveItemDto[]; path: DriveCrumb[]; role: DriveRole; storageUsed: number; storageLimit: number | null };

const MAX_ENTRIES = 50;
// Listings already fetched this session, keyed by the page's request key, so going back to a folder
// renders at once. Lives in memory only: a reload starts empty. The page still refetches in the background.
const listings = new Map<string, DriveListing>();

export function readDriveListing(key: string) {
	return listings.get(key);
}

export function saveDriveListing(key: string, listing: DriveListing) {
	listings.delete(key);
	listings.set(key, listing);
	if (listings.size > MAX_ENTRIES) listings.delete(listings.keys().next().value!);
}

// After a change, other cached listings may be out of date (a moved file, an upload into another folder).
export function clearDriveListings() {
	listings.clear();
}

// A listing belongs to the account that fetched it; sign-out and account switches do not reload the page.
if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearDriveListings);
}
