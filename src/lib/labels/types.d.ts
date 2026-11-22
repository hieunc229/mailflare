export type Label = {
	id: string;
	mailboxId: string;
	name: string;
	color: string;
};

/** What a list row or an open conversation shows of a label. */
export type LabelChip = Pick<Label, "id" | "name" | "color">;
