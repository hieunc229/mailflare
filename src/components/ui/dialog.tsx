"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
	className,
	children,
	...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35" />
			<DialogPrimitive.Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-6 shadow-xl",
					className,
				)}
				{...props}
			>
				{children}
				<DialogPrimitive.Close className="absolute right-4 top-4 rounded-full p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">
					<X className="h-4 w-4" />
					<span className="sr-only">Close</span>
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("mb-5 space-y-1.5", className)} {...props} />;
}

export function DialogTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
	return <DialogPrimitive.Title className={cn("text-lg font-semibold text-neutral-900", className)} {...props} />;
}

export function DialogDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
	return <DialogPrimitive.Description className={cn("text-sm text-neutral-500", className)} {...props} />;
}
