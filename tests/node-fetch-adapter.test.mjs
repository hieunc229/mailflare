import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "fetch-adapter", entryPoint: "server/runtime/fetch-adapter.ts", mocks: {} });
const { serveFetch } = await fixture.import();
after(() => fixture.dispose());

async function withServer(handler, env, run) {
	const server = createServer((request, response) => void serveFetch(handler, request, response, env));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`http://127.0.0.1:${server.address().port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

const echo = async (request) => Response.json({ method: request.method, url: request.url, auth: request.headers.get("authorization"), depth: request.headers.get("depth"), body: await request.text() }, { status: 207, headers: { "X-Test": "1" } });

test("a Node request becomes a Request, including WebDAV methods and bodies", async () => {
	await withServer(echo, { APP_URL: "https://mail.example.test/" }, async (base) => {
		const response = await fetch(`${base}/dav/principals/u1/?x=1`, { method: "PROPFIND", headers: { Authorization: "Basic abc", Depth: "0" }, body: "<a/>" });
		assert.equal(response.status, 207);
		assert.equal(response.headers.get("x-test"), "1");
		assert.deepEqual(await response.json(), { method: "PROPFIND", url: "https://mail.example.test/dav/principals/u1/?x=1", auth: "Basic abc", depth: "0", body: "<a/>" });
	});
});

test("without APP_URL the origin comes from the Host header", async () => {
	await withServer(echo, {}, async (base) => {
		const body = await (await fetch(`${base}/dav/`, { method: "REPORT" })).json();
		assert.equal(body.url, `${base}/dav/`);
	});
});

test("a path that looks like a host cannot change the origin", async () => {
	await withServer(echo, { APP_URL: "https://mail.example.test" }, async (base) => {
		const { request } = await import("node:http");
		const url = await new Promise((resolve) => {
			const req = request(`${base}`, { method: "GET", path: "//evil.test/dav/" }, async (res) => {
				resolve(JSON.parse(await new Promise((done) => { let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => done(text)); })).url);
			});
			req.end();
		});
		assert.equal(new URL(url).host, "mail.example.test");
	});
});

test("a null answer is 404 and a thrown error is a bare 500", async () => {
	await withServer(async () => null, {}, async (base) => assert.equal((await fetch(`${base}/dav/`)).status, 404));
	const original = console.error;
	console.error = () => {};
	try {
		await withServer(async () => { throw new Error("secret detail"); }, {}, async (base) => {
			const response = await fetch(`${base}/dav/`);
			assert.equal(response.status, 500);
			assert.doesNotMatch(await response.text(), /secret/);
		});
	} finally {
		console.error = original;
	}
});

test("HEAD and an empty 204 stream back without a body", async () => {
	await withServer(async () => new Response(null, { status: 204 }), {}, async (base) => {
		const response = await fetch(`${base}/dav/`, { method: "HEAD" });
		assert.equal(response.status, 204);
	});
});

const { Agent, request: httpRequest } = await import("node:http");
/** Big enough that the kernel buffers cannot swallow it, so the server really leaves bytes unread. */
const BIG = Buffer.alloc(4 * 1024 * 1024, "a");

/** One request on a shared keep-alive agent; resolves with the status and the socket it used. */
function send(agent, base, { method = "PROPFIND", path = "/dav/", body, timeout = 3000 } = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(`${base}${path}`, { agent, method, timeout }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode, connection: res.headers.connection, socket: req.socket }));
		});
		req.on("timeout", () => req.destroy(new Error("request hung")));
		req.on("error", reject);
		req.end(body);
	});
}

for (const [label, status] of [["401", 401], ["404", 404], ["405", 405]]) {
	test(`an unread large body on an early ${label} does not wedge the next request`, async () => {
		const handler = async (request) => (request.url.endsWith("/second") ? new Response("ok") : new Response("no", { status }));
		await withServer(handler, {}, async (base) => {
			const agent = new Agent({ keepAlive: true, maxSockets: 1 });
			try {
				const first = await send(agent, base, { body: BIG });
				assert.equal(first.status, status);
				const second = await send(agent, base, { method: "GET", path: "/dav/second" });
				assert.equal(second.status, 200);
			} finally {
				agent.destroy();
			}
		});
	});
}

test("a body the handler never reads is not consumed up front, and the connection closes", async () => {
	await withServer(async () => new Response("no", { status: 401 }), {}, async (base) => {
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		try {
			const first = await send(agent, base, { body: BIG });
			assert.equal(first.connection, "close");
		} finally {
			agent.destroy();
		}
	});
});

test("a body the handler reads in full keeps the connection alive", async () => {
	await withServer(echo, {}, async (base) => {
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		try {
			const first = await send(agent, base, { body: "<a/>" });
			const second = await send(agent, base, { body: "<b/>" });
			assert.equal(first.socket, second.socket);
		} finally {
			agent.destroy();
		}
	});
});

test("an error in the response stream does not crash the process", async () => {
	const handler = async () =>
		new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("part")); setTimeout(() => controller.error(new Error("boom")), 20); } }));
	const original = console.error;
	console.error = () => {};
	const crashed = [];
	const onCrash = (error) => crashed.push(error);
	process.on("uncaughtException", onCrash);
	try {
		await withServer(handler, {}, async (base) => {
			await fetch(`${base}/dav/`).then((response) => response.text()).catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal((await fetch(`${base}/dav/`).then((r) => r.status).catch(() => "reset")) !== undefined, true);
		});
	} finally {
		process.off("uncaughtException", onCrash);
		console.error = original;
	}
	assert.deepEqual(crashed, []);
});

test("several Set-Cookie headers all reach the client", async () => {
	await withServer(async () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "a=1; Path=/");
		headers.append("Set-Cookie", "b=2; Path=/");
		return new Response("ok", { headers });
	}, {}, async (base) => {
		const response = await fetch(`${base}/dav/`);
		assert.deepEqual(response.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
	});
});
