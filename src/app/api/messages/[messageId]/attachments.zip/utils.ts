import { truncateUtf8 } from "@/lib/email/inbound-limits";

// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069"*/:<>?\\|]/g;

/** Download name for the all-attachments archive: the subject when there is one. */
export function attachmentsZipName(subject: string | null | undefined): string {
	const cleaned = (subject ?? "")
		.replace(UNSAFE_FILENAME, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.zip$/i, "")
		.replace(/[. ]+$/, "");
	return `${cleaned ? truncateUtf8(cleaned, 80) : "attachments"}.zip`;
}
