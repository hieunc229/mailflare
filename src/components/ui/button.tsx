import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-blue-600 text-white hover:bg-blue-700",
				outline: "border border-neutral-200 bg-white hover:bg-neutral-100",
				ghost: "hover:bg-neutral-100",
				// Icon button whose hover background grows from the centre.
				round: "relative isolate rounded-full before:absolute before:inset-0 before:-z-10 before:rounded-full before:bg-neutral-100 before:scale-0 before:opacity-0 before:transition-[scale,opacity] before:duration-150 before:ease-out hover:before:scale-100 hover:before:opacity-100 focus-visible:before:scale-100 focus-visible:before:opacity-100 data-[state=open]:before:scale-100 data-[state=open]:before:opacity-100 motion-reduce:before:transition-none",
				destructive: "bg-red-600 text-white hover:bg-red-700",
				secondary: "bg-neutral-100"
			},
			size: {
				default: "h-10 px-6 py-2 rounded-xl",
				sm: "h-8 rounded-lg px-3 text-xs",
				lg: "h-11 rounded-xl px-8",
				roundedSM: "rounded-full p-2 text-xs",
				icon: "",
				round: "h-8 w-8 shrink-0 rounded-full p-0 text-xs",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
	VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return <Comp className={cn('cursor-pointer', buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
	},
);
Button.displayName = "Button";
