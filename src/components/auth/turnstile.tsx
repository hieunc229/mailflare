"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

type TurnstileWindow = Window & {
	turnstile?: {
		render: (
			container: HTMLElement,
			options: {
				sitekey: string;
				callback: (token: string) => void;
				"expired-callback": () => void;
				"error-callback": () => void;
			},
		) => string;
		reset: (widgetId?: string) => void;
		remove: (widgetId?: string) => void;
	};
};

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

function loadTurnstileScript(): Promise<void> {
	const existing = document.querySelector<HTMLScriptElement>("script[data-turnstile]");
	if (existing) {
		return existing.dataset.loaded === "true"
			? Promise.resolve()
			: new Promise((resolve, reject) => {
				existing.addEventListener("load", () => resolve(), { once: true });
				existing.addEventListener("error", () => reject(new Error("Turnstile failed to load")), { once: true });
			});
	}

	return new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		script.defer = true;
		script.dataset.turnstile = "true";
		script.addEventListener("load", () => {
			script.dataset.loaded = "true";
			resolve();
		});
		script.addEventListener("error", () => {
			// Leave no dead script behind, or later mounts would wait on it forever.
			script.remove();
			reject(new Error("Turnstile failed to load"));
		});
		document.head.appendChild(script);
	});
}

export function TurnstileField({
	name = "turnstileToken",
	resetSignal,
}: {
	name?: string;
	resetSignal?: number;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const widgetId = useRef<string | undefined>(undefined);
	const [token, setToken] = useState("");

	useEffect(() => {
		if (!TURNSTILE_SITE_KEY || !containerRef.current) return;
		let cancelled = false;

		void loadTurnstileScript().then(() => {
			if (cancelled || !containerRef.current) return;
			const turnstile = (window as TurnstileWindow).turnstile;
			if (!turnstile || widgetId.current) return;
			widgetId.current = turnstile.render(containerRef.current, {
				sitekey: TURNSTILE_SITE_KEY,
				callback: setToken,
				"expired-callback": () => setToken(""),
				"error-callback": () => setToken(""),
			});
		}).catch(() => {
			// The widget stays empty; a later mount retries the load.
		});

		return () => {
			cancelled = true;
			const turnstile = (window as TurnstileWindow).turnstile;
			if (turnstile && widgetId.current) turnstile.remove(widgetId.current);
			widgetId.current = undefined;
		};
	}, []);

	useEffect(() => {
		if (!resetSignal || !widgetId.current) return;
		(window as TurnstileWindow).turnstile?.reset(widgetId.current);
		setToken("");
	}, [resetSignal]);

	if (!TURNSTILE_SITE_KEY) return null;

	return (
		<div className="space-y-2">
			<div ref={containerRef} />
			<Input type="hidden" name={name} value={token} />
		</div>
	);
}
