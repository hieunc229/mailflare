import type * as React from "react";

/** What `onChange` receives: the same `event.target.value` / `event.currentTarget.value` shape as a native <select>. */
export type SelectChangeEvent = {
  target: { value: string; name?: string };
  currentTarget: { value: string; name?: string };
};

export type SelectProps = Omit<
  React.ComponentProps<"select">,
  "onChange" | "value" | "defaultValue" | "multiple" | "size"
> & {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  /** Shown when no option matches `value`. */
  placeholder?: React.ReactNode;
  containerClassName?: string;
};
