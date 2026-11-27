import VCard from "vcard-creator";

// The slice of a contacts row a card needs; blocked senders stay in the export
// (it is the user's whole address book) and keep their flag as CATEGORIES:Blocked.
export interface ContactVCardRow {
	email: string;
	displayName: string | null;
	blocked: boolean;
}

export function contactToVCard(contact: ContactVCardRow): VCard {
	const card = new VCard();
	// displayName is one free-form field: it fills FN, and N's family slot so
	// N-reading importers still see it. The address stands in when there is no name.
	card.addName({ familyName: contact.displayName?.trim() || contact.email });
	card.addEmail({ address: contact.email });
	if (contact.blocked) card.addCategories("Blocked");
	return card;
}

/** vCard 3.0 stream: one BEGIN:VCARD/END:VCARD block per contact, CRLF endings. */
export function contactsToVcf(rows: ContactVCardRow[]): string {
	return VCard.concat(...rows.map(contactToVCard));
}
