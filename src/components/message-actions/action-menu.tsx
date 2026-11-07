"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const messageActionMenuItemClass =
	"flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-neutral-400 data-[highlighted]:bg-neutral-100";

type MessageActionMenuProps = {
	/** Tooltip and accessible name for the trigger. */
	label: string;
	trigger: ReactNode;
	children: ReactNode;
	/** Extra classes for the portaled panel, never for positioning it. */
	className?: string;
};

/**
 * The overflow menu for message actions. Radix portals it to the body and
 * keeps it inside the viewport, so a trigger near the left edge opens to the
 * right instead of off-screen, and a long list scrolls instead of running
 * below the screen.
 */
export function MessageActionMenu({ label, trigger, children, className }: MessageActionMenuProps) {
	return (
		<DropdownMenu.Root>
			<Tooltip label={label}>
				<DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="end"
					sideOffset={6}
					collisionPadding={8}
					className={cn(
						"z-[130] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 text-sm shadow-lg",
						className,
					)}
				>
					{children}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

type MessageActionMenuItemProps = {
	icon: ReactNode;
	children: ReactNode;
	onSelect: () => void;
	disabled?: boolean;
	destructive?: boolean;
};

export function MessageActionMenuItem({ icon, children, onSelect, disabled, destructive }: MessageActionMenuItemProps) {
	return (
		<DropdownMenu.Item
			disabled={disabled}
			onSelect={onSelect}
			className={cn(
				messageActionMenuItemClass,
				destructive && "text-red-600 data-[highlighted]:bg-red-50",
			)}
		>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">{icon}</span>
			<span className="min-w-0 flex-1">{children}</span>
		</DropdownMenu.Item>
	);
}

export function MessageActionMenuSeparator() {
	return <DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />;
}

export function MessageActionMenuLabel({ children }: { children: ReactNode }) {
	return <DropdownMenu.Label className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">{children}</DropdownMenu.Label>;
}
