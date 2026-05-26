import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type AuthShellStep = {
	label: string;
	active: boolean;
};

export type AuthShellProps = {
	icon: LucideIcon;
	title: string;
	description: ReactNode;
	children: ReactNode;
	footer: ReactNode;
	steps?: AuthShellStep[];
};
