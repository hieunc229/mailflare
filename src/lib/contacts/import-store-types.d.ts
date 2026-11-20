import type { ContactNameSource } from "./types";
import type { ImportedContact } from "./vcard-types";

export type ContactImportBody = {
	mailboxId: string;
	format: "vcard" | "google-csv";
	items?: { vcard: string; hasPhoto: boolean }[];
	csv?: { header: string[]; rows: string[][] };
};

export type ImportedCard = { contact: ImportedContact; hasPhoto: boolean };

export type ExistingContact = ContactNameSource & { avatarKey: string | null };

export type ContactImportPlan = {
	contacts: { id: string; userId: string; email: string; displayName: string | null; source: ContactNameSource["source"] }[];
	renames: { id: string; displayName: string | null; source: ContactNameSource["source"] }[];
	detailInserts: { contactId: string; details: string; updatedAt: Date }[];
	detailUpdates: { contactId: string; details: string; updatedAt: Date }[];
	created: number;
	updated: number;
	unchanged: number;
	noEmail: number;
	/** Primary addresses whose card has a photo and whose contact has no picture yet. */
	photoTargets: string[];
};

export type ContactImportSummary = {
	created: number;
	updated: number;
	unchanged: number;
	noEmail: number;
	photoTargets: string[];
};
