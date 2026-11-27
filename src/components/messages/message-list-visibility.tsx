"use client";

import { createContext, useContext } from "react";
import type { MessageListVisibility } from "./types";

export const MessageListVisibilityContext = createContext<MessageListVisibility>({ visible: true, singleColumn: false, backHref: "/inbox", backLabel: "Inbox" });

export function useMessageListVisibility() {
	return useContext(MessageListVisibilityContext);
}
