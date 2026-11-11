"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { SelectProps } from "./select-types";

// Radix does not allow an empty-string item value (it means "no selection"), but <option value="">
// is common for "None" / "Choose…" rows, so those rows use this stand-in internally.
const EMPTY_VALUE = "__select_empty__";

type ParsedOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  lang?: string;
};

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

// Reads <option> children (also inside fragments, arrays and conditionals) so call sites keep the native API.
function parseOptions(children: React.ReactNode): ParsedOption[] {
  const options: ParsedOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<{
      value?: string | number;
      disabled?: boolean;
      lang?: string;
      children?: React.ReactNode;
    }>(child)) return;
    if (child.type === React.Fragment || child.type === "optgroup") {
      options.push(...parseOptions(child.props.children));
      return;
    }
    if (child.type !== "option") return;
    options.push({
      value: String(child.props.value ?? textOf(child.props.children)),
      label: child.props.children,
      disabled: child.props.disabled,
      lang: child.props.lang,
    });
  });
  return options;
}

export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      className,
      containerClassName,
      children,
      value,
      defaultValue,
      onChange,
      placeholder,
      disabled,
      required,
      name,
      id,
      lang,
      form,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
    },
    ref,
  ) => {
    const options = parseOptions(children);
    const hasEmptyOption = options.some((option) => option.value === "");
    const toInternal = (raw: string) => (raw === "" && hasEmptyOption ? EMPTY_VALUE : raw);
    const [uncontrolled, setUncontrolled] = React.useState(String(defaultValue ?? ""));
    const current = value === undefined ? uncontrolled : String(value);

    function handleValueChange(next: string) {
      const raw = next === EMPTY_VALUE ? "" : next;
      if (value === undefined) setUncontrolled(raw);
      onChange?.({ target: { value: raw, name }, currentTarget: { value: raw, name } });
    }

    return (
      <span className={cn("relative inline-flex rounded-lg border border-neutral-200 px-2", containerClassName)}>
        <SelectPrimitive.Root
          value={toInternal(current)}
          onValueChange={handleValueChange}
          disabled={disabled}
        >
          <SelectPrimitive.Trigger
            ref={ref}
            id={id}
            lang={lang}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={ariaDescribedBy}
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-2 rounded-md bg-transparent text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-neutral-500",
              className,
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              <SelectPrimitive.Value placeholder={placeholder} />
            </span>
            <SelectPrimitive.Icon asChild>
              <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-neutral-500" />
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal>
            <SelectPrimitive.Content
              position="popper"
              align="start"
              sideOffset={4}
              collisionPadding={8}
              className="z-[300] max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border border-neutral-200 bg-white text-sm text-neutral-900 shadow-lg"
            >
              <SelectPrimitive.Viewport className="max-h-[inherit] overflow-y-auto p-1">
                {options.map((option) => (
                  <SelectPrimitive.Item
                    key={option.value}
                    value={toInternal(option.value)}
                    disabled={option.disabled}
                    lang={option.lang}
                    className="relative flex cursor-pointer select-none items-center rounded-md py-1.5 pr-8 pl-3 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100"
                  >
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
                      <Check size={16} />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
        {(name || required) && (
          // Radix renders no form control of its own; this one carries the name/value into FormData
          // and makes `required` block submit while nothing is chosen.
          <input
            tabIndex={-1}
            aria-hidden="true"
            name={name}
            form={form}
            required={required}
            value={current}
            onChange={() => {}}
            className="pointer-events-none absolute h-0 w-0 opacity-0"
          />
        )}
      </span>
    );
  },
);
Select.displayName = "Select";
