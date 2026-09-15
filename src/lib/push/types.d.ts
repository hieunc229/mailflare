export interface PushNotificationPayload {
	type: "new_message";
	messageId: string;
	mailboxId: string;
	from: string;
	fromName: string | null;
	subject: string | null;
}

/** A single item in the Expo Push API request body array. */
export interface ExpoPushMessage {
	to: string;
	title: string;
	body: string;
	sound?: "default" | null;
	data?: Record<string, unknown>;
	channelId?: string;
	priority?: "default" | "normal" | "high";
}

/** A single ticket returned by the Expo Push API for each message sent. */
export interface ExpoPushTicket {
	status: "ok" | "error";
	id?: string;
	message?: string;
	details?: {
		error?:
			| "DeviceNotRegistered"
			| "InvalidCredentials"
			| "MessageTooBig"
			| "MessageRateExceeded";
	};
}

/** Top-level response from `POST https://exp.host/--/api/v2/push/send`. */
export interface ExpoPushResponse {
	data: ExpoPushTicket[];
}
