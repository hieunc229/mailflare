import type { TranslationKey } from "@/lib/i18n/types";
import type { LucideIcon } from "@/components/icons";
import type { ButtonProps } from "@/components/ui/button";
import type { MailboxSelectorUser } from "@/components/mailbox-selector-types";
import type { ReactNode } from "react";

export type HomeAuthProviderProps = {
	children: ReactNode;
	/**
	 * The account resolved from the session cookie on the server. `undefined`
	 * means the server did not answer, so the provider must check itself.
	 */
	initialUser?: MailboxSelectorUser | null;
};

export type HomeAccountMenuProps = {
	user: MailboxSelectorUser;
};

export type HomeAction = {
	href: string;
	labelKey: TranslationKey;
	variant: ButtonProps["variant"];
};

export type LandingNavItem = {
	href: string;
	label: string;
};

export type SidebarItem = {
	labelKey: TranslationKey;
	icon: LucideIcon;
	active?: boolean;
	count?: string;
};

export type MailPreview = {
	icon: LucideIcon;
	sender: string;
	subjectKey: TranslationKey;
	previewKey: TranslationKey;
	badgeKey: TranslationKey;
};

export type LandingStat = {
	value: string;
	label: string;
};
