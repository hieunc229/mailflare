"use client";

import { useEffect, useState } from "react";
import type { MessageAuthenticationResponse } from "@/lib/email/authentication-types";
import { fetchMessageAuthentication } from "./message-details-utils";

/** Stored results are immutable, so cache them across the reader. */
const resolved = new Map<string, MessageAuthenticationResponse>();
const pending = new Map<string, Promise<MessageAuthenticationResponse>>();
const queue: Array<() => void> = [];
const MAX_CONCURRENT_REQUESTS = 4;
let activeRequests = 0;

function schedule<T>(task: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const run = () => {
			activeRequests += 1;
			task()
				.then(resolve, reject)
				.finally(() => {
					activeRequests -= 1;
					queue.shift()?.();
				});
		};
		if (activeRequests < MAX_CONCURRENT_REQUESTS) run();
		else queue.push(run);
	});
}

function loadMessageAuthentication(messageId: string): Promise<MessageAuthenticationResponse> {
	const cached = resolved.get(messageId);
	if (cached) return Promise.resolve(cached);
	const inFlight = pending.get(messageId);
	if (inFlight) return inFlight;

	const request = schedule(() => fetchMessageAuthentication(messageId))
		.then((result) => {
			resolved.set(messageId, result);
			return result;
		})
		.finally(() => {
			pending.delete(messageId);
		});
	pending.set(messageId, request);
	return request;
}

type AuthenticationState = {
	messageId: string;
	authentication: MessageAuthenticationResponse | null;
	failed: boolean;
};

export type MessageAuthenticationState = {
	authentication: MessageAuthenticationResponse | null;
	failed: boolean;
	loading: boolean;
};

/** Loads authentication once per message, with at most four concurrent requests. */
export function useMessageAuthentication(
	messageId: string | null | undefined,
	direction: string | null | undefined,
): MessageAuthenticationState {
	const [state, setState] = useState<AuthenticationState | null>(null);
	const inbound = !!messageId && direction === "inbound";

	useEffect(() => {
		if (!messageId || !inbound) return;
		let cancelled = false;
		loadMessageAuthentication(messageId)
			.then((authentication) => {
				if (!cancelled) setState({ messageId, authentication, failed: false });
			})
			.catch(() => {
				if (!cancelled) setState({ messageId, authentication: null, failed: true });
			});
		return () => {
			cancelled = true;
		};
	}, [messageId, inbound]);

	const current = state?.messageId === messageId ? state : null;
	const authentication = current?.authentication ?? (messageId ? resolved.get(messageId) ?? null : null);
	const failed = current?.failed ?? false;
	return {
		authentication,
		failed,
		loading: inbound && !authentication && !failed,
	};
}
