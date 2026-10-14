"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/language-provider";
import { getDirection } from "@/lib/i18n/utils";

type NativeSelectProps = React.ComponentProps<"select">;
type Choice = { value: string; label: React.ReactNode; disabled: boolean; selected: boolean };

function choicesFrom(children: React.ReactNode, groupDisabled = false): Choice[] {
	const choices: Choice[] = [];
	React.Children.forEach(children, (child) => {
		if (!React.isValidElement(child)) return;
		if (child.type === React.Fragment) {
			choices.push(...choicesFrom((child.props as { children?: React.ReactNode }).children, groupDisabled));
			return;
		}
		if (child.type === "optgroup") {
			const props = child.props as React.ComponentProps<"optgroup">;
			choices.push(...choicesFrom(props.children, groupDisabled || !!props.disabled));
			return;
		}
		if (child.type !== "option") return;
		const props = child.props as React.ComponentProps<"option">;
		const label = props.label ?? props.children;
		choices.push({
			value: String(props.value ?? (typeof label === "string" || typeof label === "number" ? label : "")),
			label,
			disabled: groupDisabled || !!props.disabled,
			selected: !!props.selected,
		});
	});
	return choices;
}

function labelText(label: HTMLLabelElement): string {
	const copy = label.cloneNode(true) as HTMLLabelElement;
	copy.querySelectorAll("select, button, input, textarea").forEach((control) => control.remove());
	return copy.textContent?.trim() ?? "";
}

function initialIndex(choices: Choice[], value: NativeSelectProps["value"], defaultValue: NativeSelectProps["defaultValue"]): number {
	const requested = value ?? defaultValue;
	if (requested != null) {
		const match = choices.findIndex((choice) => choice.value === String(requested));
		if (match >= 0) return match;
	}
	const selected = choices.findIndex((choice) => choice.selected);
	if (selected >= 0) return selected;
	return choices.findIndex((choice) => !choice.disabled);
}

export const CustomSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
	({ children, className, style, value, defaultValue, onChange, onFocus, onBlur, onKeyDown, onClick, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, disabled, required, dir, ...props }, forwardedRef) => {
		const { locale } = useLanguage();
		const nativeRef = React.useRef<HTMLSelectElement>(null);
		const triggerRef = React.useRef<HTMLButtonElement>(null);
		const choices = choicesFrom(children);
		const controlled = value !== undefined;
		const [uncontrolledIndex, setUncontrolledIndex] = React.useState(() => initialIndex(choices, value, defaultValue));
		const [associatedLabel, setAssociatedLabel] = React.useState<string>();
		const [direction, setDirection] = React.useState<"ltr" | "rtl">(dir === "rtl" || (dir == null && getDirection(locale) === "rtl") ? "rtl" : "ltr");
		const selectedIndex = controlled ? initialIndex(choices, value, undefined) : uncontrolledIndex;
		const selected = choices[selectedIndex];
		const longestLabel = choices.reduce<React.ReactNode>((longest, choice) => String(choice.label).length > String(longest ?? "").length ? choice.label : longest, "");

		React.useImperativeHandle(forwardedRef, () => nativeRef.current!, []);

		React.useLayoutEffect(() => {
			const native = nativeRef.current;
			if (!native) return;
			if (!ariaLabel && !ariaLabelledBy) {
				setAssociatedLabel(Array.from(native.labels ?? []).map(labelText).filter(Boolean).join(" ") || undefined);
			}
			if (!controlled) setUncontrolledIndex(native.selectedIndex);
			setDirection(dir === "rtl" || (dir == null && (native.closest("[dir]")?.getAttribute("dir") ?? native.ownerDocument.documentElement.dir) === "rtl") ? "rtl" : "ltr");
		}, [ariaLabel, ariaLabelledBy, controlled, children, dir, locale]);

		React.useEffect(() => {
			const native = nativeRef.current;
			const form = native?.form;
			if (!form || controlled) return;
			const syncAfterReset = () => queueMicrotask(() => {
				if (native.isConnected) setUncontrolledIndex(native.selectedIndex);
			});
			form.addEventListener("reset", syncAfterReset);
			return () => form.removeEventListener("reset", syncAfterReset);
		}, [controlled, props.form]);

		const choose = (id: string) => {
			const index = Number(id.slice(5));
			const native = nativeRef.current;
			if (!native || !Number.isInteger(index) || !choices[index] || choices[index].disabled) return;
			native.selectedIndex = index;
			if (!controlled) setUncontrolledIndex(index);
			native.dispatchEvent(new Event("change", { bubbles: true }));
		};

		const handleNativeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
			if (!controlled) setUncontrolledIndex(event.currentTarget.selectedIndex);
			onChange?.(event);
		};

		return (
			<>
				<select
					{...props}
					ref={nativeRef}
					value={value}
					defaultValue={defaultValue}
					onChange={handleNativeChange}
					onFocus={() => triggerRef.current?.focus()}
					onClick={(event) => { event.preventDefault(); onClick?.(event); if (!disabled) triggerRef.current?.click(); }}
					aria-hidden="true"
					tabIndex={-1}
					disabled={disabled}
					required={required}
					dir={dir}
					className="absolute h-px w-px overflow-hidden border-0 p-0 opacity-0"
				>
					{children}
				</select>
				<SelectPrimitive.Root value={selected ? `item-${selectedIndex}` : undefined} onValueChange={choose} disabled={disabled} dir={direction}>
					<SelectPrimitive.Trigger
						ref={triggerRef}
						aria-label={ariaLabel ?? associatedLabel}
						aria-labelledby={ariaLabelledBy}
						aria-describedby={props["aria-describedby"]}
						aria-invalid={props["aria-invalid"]}
						aria-required={required}
						onFocus={onFocus as React.FocusEventHandler<HTMLButtonElement> | undefined}
						onBlur={onBlur as React.FocusEventHandler<HTMLButtonElement> | undefined}
						onKeyDown={onKeyDown as React.KeyboardEventHandler<HTMLButtonElement> | undefined}
						data-ui-select-trigger=""
						className={cn("inline-flex min-w-0 items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50", className, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600")}
						style={style}
					>
						<span className="min-w-0 flex-1">
						<SelectPrimitive.Value placeholder=" ">
							<span className="grid min-w-0 text-start">
								<span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap px-2">{longestLabel}</span>
								<span className="col-start-1 row-start-1 min-w-0 truncate">{selected?.label}</span>
							</span>
						</SelectPrimitive.Value>
						</span>
						<SelectPrimitive.Icon aria-hidden="true" className="shrink-0 text-neutral-500"><ChevronDown className="h-4 w-4" /></SelectPrimitive.Icon>
					</SelectPrimitive.Trigger>
					<SelectPrimitive.Portal>
						<SelectPrimitive.Content position="popper" sideOffset={8} collisionPadding={8} data-ui-popup="select" style={{ width: "var(--radix-select-trigger-width)" }} className="z-[100] min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-neutral-200 bg-white p-1 text-neutral-800">
							<SelectPrimitive.Viewport style={{ maxHeight: "min(16rem, calc(var(--radix-select-content-available-height) - 10px))" }} className="overflow-y-auto overscroll-contain">
								{choices.map((choice, index) => (
									<SelectPrimitive.Item key={index} value={`item-${index}`} disabled={choice.disabled} textValue={typeof choice.label === "string" ? choice.label : undefined} className="relative flex min-w-0 cursor-default select-none items-center rounded-md py-2 ps-3 pe-8 text-sm outline-none data-[highlighted]:bg-blue-50 data-[highlighted]:text-blue-900 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50">
										<SelectPrimitive.ItemText>{choice.label}</SelectPrimitive.ItemText>
										<SelectPrimitive.ItemIndicator className="absolute end-2 text-blue-600"><Check className="h-4 w-4" /></SelectPrimitive.ItemIndicator>
									</SelectPrimitive.Item>
								))}
							</SelectPrimitive.Viewport>
						</SelectPrimitive.Content>
					</SelectPrimitive.Portal>
				</SelectPrimitive.Root>
			</>
		);
	},
);
CustomSelect.displayName = "CustomSelect";
