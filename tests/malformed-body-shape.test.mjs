import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "tests", ".tmp-malformed-shape-"));
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.shapeEnv; delete globalThis.shapeSesState; });

// A JSON body that parses but is not an object (null, an array, a scalar) used to
// sail through the try/catch around JSON.parse and crash the first property read.
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return globalThis.shapeEnv ?? {}}",
	"@/lib/http/request": "export async function readRawBody(request){return request.arrayBuffer()}",
	"@/lib/http/errors": "export class RequestBodyTooLargeError extends Error{}",
	"@/lib/email/address": "export function getEmailAddress(){return 'sender@test.example'} export function getEmailAddressList(value){return [value]}",
	"@/lib/email/outbound-provider": "export async function getResendClient(){return {}}",
	"@/lib/email/provider-intake": "export async function intakeProviderMail(){return {action:'store'}}",
	"@/lib/email/resend-api": "export async function getReceivedEmail(){return {from:'a@b.c',to:['d@e.f'],raw:{download_url:'https://download.test/raw.eml'}}}",
	"@/lib/email/svix": "export async function verifySvixSignature(){return true}",
	"@/lib/domains/resend-receiving": "export async function getResendWebhookSecret(){return 'whsec_test'}",
	"@/lib/aws/config": "export async function requireAwsConfig(){return {}}",
	"@/lib/aws/s3": "export async function deleteObject(){} export async function getObject(){return new ArrayBuffer(8)}",
	"@/lib/aws/ses-receiving": "export const SES_OBJECT_PREFIX='inbound/'; export async function getSesReceivingState(){return globalThis.shapeSesState ?? null}",
	"@/lib/aws/sns-signature": "export async function verifySnsSignature(){return true}",
	"cloudflare:workers": "export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}",
	"./revision": "export async function getUserMailRevision(){return 'rev-2'}",
};

await build({
	stdin: {
		contents: `export * as resend from './src/app/api/inbound/resend/route';export * as ses from './src/app/api/inbound/ses/route';export * as hub from './src/lib/realtime/hub';`,
		resolveDir: project,
		loader: "ts",
	},
	outfile: join(temporary, "routes.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(project, "src") },
	plugins: [{ name: "malformed-body-shape-mocks", setup(builder) {
		builder.onResolve({ filter: /.*/ }, (args) => (
			args.path in mocks ? { path: args.path, namespace: "mock" } : undefined
		));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
	logLevel: "silent",
});
const { resend, ses, hub } = await import(pathToFileURL(join(temporary, "routes.mjs")).href);

const post = (path, body) => new Request(`https://mail.test${path}`, { method: "POST", body });
const sesState = { token: "tok", topicArn: "arn:aws:sns:us-east-1:123:mail", bucket: "mail-bucket" };
const sesPost = (envelope) => post("/api/inbound/ses?token=tok", typeof envelope === "string" ? envelope : JSON.stringify(envelope));

test("POST /api/inbound/resend answers 400 when the event parses but is not an object", async () => {
	for (const body of ["null", "[1,2]", "5", '"text"']) {
		const response = await resend.POST(post("/api/inbound/resend", body));
		assert.equal(response.status, 400, `body ${body}`);
		assert.equal((await response.json()).error, "Invalid body");
	}
});

test("POST /api/inbound/resend still ignores non-received events and processes valid ones", async () => {
	assert.equal((await resend.POST(post("/api/inbound/resend", "{}"))).status, 200);
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("raw mime", { status: 200 });
	try {
		const response = await resend.POST(post("/api/inbound/resend", '{"type":"email.received","data":{"email_id":"e-1"}}'));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).action, "store");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("POST /api/inbound/ses answers 400 when the envelope parses but is not an object", async () => {
	globalThis.shapeSesState = sesState;
	for (const body of ["null", "[1,2]", "5", '"text"']) {
		const response = await ses.POST(sesPost(body));
		assert.equal(response.status, 400, `body ${body}`);
		assert.equal((await response.json()).error, "Invalid body");
	}
});

test("POST /api/inbound/ses answers 400 for a non-string or malformed SubscribeURL", async () => {
	globalThis.shapeSesState = sesState;
	for (const subscribeURL of [123, {}, "notaurl"]) {
		const envelope = { Type: "SubscriptionConfirmation", TopicArn: sesState.topicArn, SubscribeURL: subscribeURL };
		const response = await ses.POST(sesPost(envelope));
		assert.equal(response.status, 400, `SubscribeURL ${JSON.stringify(subscribeURL)}`);
		assert.equal((await response.json()).error, "Invalid subscription URL");
	}
});

test("POST /api/inbound/ses keeps the existing 400 for a wrong-host SubscribeURL", async () => {
	globalThis.shapeSesState = sesState;
	const envelope = { Type: "SubscriptionConfirmation", TopicArn: sesState.topicArn, SubscribeURL: "https://evil.example.com/confirm" };
	const response = await ses.POST(sesPost(envelope));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Invalid subscription URL");
});

test("POST /api/inbound/ses confirms a real subscription and intakes a notification", async () => {
	globalThis.shapeSesState = sesState;
	globalThis.shapeEnv = { BUCKET: { head: async () => null, put: async () => {} } };
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("ok", { status: 200 });
	try {
		const confirmation = await ses.POST(sesPost({ Type: "SubscriptionConfirmation", TopicArn: sesState.topicArn, SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription" }));
		assert.equal(confirmation.status, 200);
		assert.equal((await confirmation.json()).confirmed, true);

		const message = JSON.stringify({
			notificationType: "Received",
			mail: { source: "a@b.c", destination: ["d@e.f"], headers: [] },
			receipt: { recipients: ["d@e.f"], action: { type: "S3", bucketName: "mail-bucket", objectKey: "inbound/msg-1.eml" } },
		});
		const notification = await ses.POST(sesPost({ Type: "Notification", TopicArn: sesState.topicArn, MessageId: "msg-1", Message: message }));
		assert.equal(notification.status, 200);
		assert.equal((await notification.json()).action, "store");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("RealtimeHub ignores a ping message that parses but is not an object", async () => {
	const socket = { sent: [], send(message) { this.sent.push(message); }, deserializeAttachment() { return { userId: "u-1" }; }, close() {} };
	const instance = new hub.RealtimeHub({}, {});
	for (const message of ["null", "[1,2]", "5", '"text"', "{" ]) {
		await instance.webSocketMessage(socket, message);
	}
	assert.deepEqual(socket.sent, []);
});

test("RealtimeHub still answers ping and revision pings", async () => {
	const socket = { sent: [], send(message) { this.sent.push(message); }, deserializeAttachment() { return { userId: "u-1" }; }, close() {} };
	const instance = new hub.RealtimeHub({}, {});
	await instance.webSocketMessage(socket, "ping");
	await instance.webSocketMessage(socket, '{"type":"ping","revision":null}');
	assert.equal(socket.sent[0], "pong");
	assert.deepEqual(JSON.parse(socket.sent[1]), { type: "revision", revision: "rev-2", changed: false });
});
