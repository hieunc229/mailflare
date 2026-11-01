import type { ReactNode } from "react";

export type AuthGuardMode = "protected" | "public";

export type AuthGuardProps = {
	children: ReactNode;
	mode?: AuthGuardMode;
	requireMailbox?: boolean;
	requireRole?: "admin";
	requirePrimary?: boolean;
	/** Redirect to /inbox when the account's admin turned this app off. */
	requireFeature?: "calendar" | "drive";
	/** Public page that stays usable while signed in (adding another account). */
	allowAuthenticated?: boolean;
};
