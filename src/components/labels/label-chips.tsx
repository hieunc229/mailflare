import type { LabelChip } from "@/lib/labels/types";
import { cn } from "@/lib/utils";

/** The label's colour as a tint behind a darker shade of itself, so every folder colour stays readable. */
export function labelChipStyle(color: string) {
	return {
		color: `color-mix(in srgb, ${color} 72%, black)`,
		backgroundColor: `color-mix(in srgb, ${color} 14%, white)`,
	};
}

/** Label names in their colour, as Gmail shows them before a subject. Long names truncate. */
export function LabelChips({ labels, className }: { labels?: LabelChip[]; className?: string }) {
	if (!labels?.length) return null;
	return (
		<span className={cn("inline-flex min-w-0 shrink-0 items-center gap-1 align-middle", className)}>
			{labels.map((label) => (
				<span
					key={label.id}
					title={label.name}
					className="inline-block max-w-[9rem] truncate rounded px-1.5 text-xs font-medium leading-5"
					style={labelChipStyle(label.color)}
				>
					{label.name}
				</span>
			))}
		</span>
	);
}
