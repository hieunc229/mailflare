import type { QuotedEmailToggleProps } from "./quoted-email-toggle-types";

export function QuotedEmailToggle({ html }: QuotedEmailToggleProps) {
	return (
		<details className="email-quote-toggle">
			<summary aria-label="Toggle quoted email" title="Show or hide quoted email" />
			<div
				dir="auto"
				className="email-body email-quote-content max-w-none text-sm text-neutral-600"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</details>
	);
}
