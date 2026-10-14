# Shared UI controls

This proposal centralizes form controls and popup placement instead of styling each screen independently. Select and timezone suggestion popups match their trigger width, leave an 8px gap and flip above the trigger when there is insufficient space below. Keyboard focus remains visible.

CustomSelect preserves select form values behind a Radix popup. CustomCombobox replaces datalist suggestions without changing saved values. The shared Input delegates date/time types to CustomDateTimeInput, preserving validation, refs and form reset. Scheduling retains the existing past-time validation.

InstallationDialogs provides awaited confirmation, prompt and alert dialogs. Typed hostname confirmation remains required. File and multi-select controls use the same form styling. The CSS layer is scoped to body[data-ui-overrides]; email HTML stays in its shadow tree.

The draft includes flat surfaces, responsive landing-header fixes, compose spacing, avatar loading and folder/attachment view restrictions. It does not change database schemas, credentials or email delivery. Focused tests cover keyboard/form behavior, popup placement, date/time values, file selection and dialogs.
