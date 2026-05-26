import type { LucideIcon } from "lucide-react";
import type { ButtonProps } from "@/components/ui/button";

export type HomeAction = {
	href: string;
	label: string;
	variant: ButtonProps["variant"];
};

export type LandingNavItem = {
	href: string;
	label: string;
};

export type SidebarItem = {
	label: string;
	icon: LucideIcon;
	active?: boolean;
	count?: string;
};

export type MailPreview = {
	icon: LucideIcon;
	sender: string;
	subject: string;
	preview: string;
	badge: string;
};

export type LandingStat = {
	value: string;
	label: string;
};
