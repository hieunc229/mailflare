import type { ProviderVerdicts } from "@/lib/spam/types";

export type IntakeInput = {
	/** Envelope sender. */
	from: string;
	/** Envelope recipient (one message per recipient). */
	to: string;
	raw: ArrayBuffer;
	/** Lower-cased header names to values, as the Worker handler receives them. */
	headers: Record<string, string>;
	/** Authentication and spam verdicts the receiving provider computed (SES), for spam analysis. */
	verdicts?: ProviderVerdicts;
	/** The IP that connected to the provider's MX, when the headers do not carry it. */
	senderIp?: string;
};

export type IntakeActions = {
	/** Refuse the message at the edge; the SMTP listener answers 550, the relay tells the Worker to setReject. */
	reject?: (reason: string) => Promise<void> | void;
	/** Relay the raw message to another address; returns whether it went out. */
	forward?: (destination: string, headers: Record<string, string>) => Promise<boolean>;
};

export type IntakeResult =
	| { action: "reject"; reason: string }
	| { action: "forward"; forwardedTo: string | null }
	| { action: "store"; rawR2Key: string; forwardedTo: string | null };
