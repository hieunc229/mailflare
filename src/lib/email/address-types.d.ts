export type EmailAddressParts = {
	name: string | null;
	address: string;
};

export type ContactSource = "manual" | "inbound" | "outbound" | "import";
