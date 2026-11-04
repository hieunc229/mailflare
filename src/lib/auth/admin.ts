import type { SessionUser } from "./types";

export function isAdmin(user: Pick<SessionUser, "role">): boolean {
	return user.role === "admin";
}

export function assertAdmin(user: Pick<SessionUser, "role">): void {
	if (!isAdmin(user)) {
		throw new Error("Forbidden");
	}
}

/**
 * The primary admin is the single account created during setup. Only it can
 * manage other admins and reach owner-only administration pages.
 */
export function isPrimaryAdmin(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin">,
): boolean {
	return user.role === "admin" && user.isPrimaryAdmin;
}

export function assertPrimaryAdmin(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin">,
): void {
	if (!isPrimaryAdmin(user)) {
		throw new Error("Forbidden");
	}
}

/** Domains can be managed by the primary admin or an admin the primary granted it to. */
export function canManageDomains(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin" | "canManageDomains">,
): boolean {
	return isPrimaryAdmin(user) || (user.role === "admin" && user.canManageDomains);
}

/** User accounts can be managed by the primary admin or an admin the primary granted it to. */
export function canManageUsers(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin" | "canManageUsers">,
): boolean {
	return isPrimaryAdmin(user) || (user.role === "admin" && user.canManageUsers);
}

/** Only the primary admin can manage another administrator's account. */
export function canManageUserAccount(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin" | "canManageUsers">,
	account: Pick<SessionUser, "role" | "isPrimaryAdmin">,
): boolean {
	return isPrimaryAdmin(user) || (canManageUsers(user) && account.role === "user" && !account.isPrimaryAdmin);
}
