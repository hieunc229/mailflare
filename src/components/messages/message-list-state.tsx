"use client";

import { createContext, useContext } from "react";
import type { MessageListStateControl } from "./types";

/**
 * List state owned by the folder layout. Opening a message swaps the
 * full-width list for the split-view list, so selection, pagination and the
 * unread filter have to leave the page that unmounts.
 */
export const MessageListStateContext = createContext<MessageListStateControl | null>(null);

export function useMessageListState() {
	return useContext(MessageListStateContext);
}
