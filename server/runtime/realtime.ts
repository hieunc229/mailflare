import type { WebSocket } from "ws";

/**
 * Per-user WebSocket fan-out, standing in for the RealtimeHub Durable
 * Object. The HTTP server hands accepted sockets to `attach`; the
 * `REALTIME.getByName(userId).fetch("/notify")` calls the app already makes
 * land in `notify`.
 */
export class RealtimeHubRegistry {
	private readonly sockets = new Map<string, Set<WebSocket>>();

	attach(userId: string, socket: WebSocket) {
		const set = this.sockets.get(userId) ?? new Set();
		set.add(socket);
		this.sockets.set(userId, set);
		socket.on("message", (data) => {
			if (data.toString() === "ping") socket.send("pong");
		});
		socket.on("close", () => {
			set.delete(socket);
			if (set.size === 0) this.sockets.delete(userId);
		});
	}

	notify(userId: string, payload: unknown) {
		const message = JSON.stringify(payload);
		for (const socket of this.sockets.get(userId) ?? []) {
			try {
				socket.send(message);
			} catch {
				socket.close(1011, "Delivery failed");
			}
		}
	}

	connections() {
		let total = 0;
		for (const set of this.sockets.values()) total += set.size;
		return total;
	}

	/** The `DurableObjectNamespace` surface the app uses: `getByName(id).fetch(...)`. */
	namespace(): DurableObjectNamespace {
		const notify = (userId: string, payload: unknown) => this.notify(userId, payload);
		const stub = (userId: string) => ({
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = input instanceof Request ? input : new Request(input, init);
				const url = new URL(request.url);
				if (url.pathname === "/notify" && request.method === "POST") {
					notify(userId, await request.json());
					return new Response(null, { status: 204 });
				}
				return new Response("Not found", { status: 404 });
			},
		});
		return {
			getByName: (name: string) => stub(name),
			idFromName: (name: string) => ({ toString: () => name, name }),
			get: (id: { toString(): string }) => stub(id.toString()),
		} as unknown as DurableObjectNamespace;
	}
}
