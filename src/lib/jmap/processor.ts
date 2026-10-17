import { CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION, LIMITS } from "./constants";
import { JmapError } from "./errors";
import { mailboxChanges, mailboxGet, mailboxQuery, mailboxSet } from "./mailboxes";
import { emailChanges, emailGet, emailImport, emailQuery, emailQueryChanges, emailSet, emailUnsupported, searchSnippetGet, threadChanges, threadGet } from "./emails";
import { emailSubmissionChanges, emailSubmissionGet, emailSubmissionQuery, emailSubmissionSet, identityChanges, identityGet, identitySet } from "./identities";
import { getEmailState } from "./state";
import type { JmapContext, JmapInvocation, JmapMethodHandler, JmapRequest, JmapResponse } from "./types";

const METHODS: Record<string, JmapMethodHandler> = {
	"Core/echo": async (_ctx, args) => args,
	"Mailbox/get": mailboxGet,
	"Mailbox/query": mailboxQuery,
	"Mailbox/changes": mailboxChanges,
	"Mailbox/queryChanges": async () => ({ type: "cannotCalculateChanges" }),
	"Mailbox/set": mailboxSet,
	"Thread/get": threadGet,
	"Thread/changes": threadChanges,
	"Email/get": emailGet,
	"Email/query": emailQuery,
	"Email/changes": emailChanges,
	"Email/queryChanges": emailQueryChanges,
	"Email/set": emailSet,
	"Email/copy": emailUnsupported("Email/copy"),
	"Email/import": emailImport,
	"Email/parse": emailUnsupported("Email/parse"),
	"SearchSnippet/get": searchSnippetGet,
	"Identity/get": identityGet,
	"Identity/changes": identityChanges,
	"Identity/set": identitySet,
	"EmailSubmission/get": emailSubmissionGet,
	"EmailSubmission/query": emailSubmissionQuery,
	"EmailSubmission/changes": emailSubmissionChanges,
	"EmailSubmission/queryChanges": async () => ({ type: "cannotCalculateChanges" }),
	"EmailSubmission/set": emailSubmissionSet,
};

export const SUPPORTED_CAPABILITIES = new Set([CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION]);

/** Every IETF JMAP capability lives in this namespace, including optional extensions. */
const JMAP_CAPABILITY_NAMESPACE = "urn:ietf:params:jmap:";

/** JSON Pointer lookup with the JMAP `*` array-flattening extension. */
function resolvePointer(value: unknown, path: string): unknown {
	const segments = path.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
	let current: unknown = value;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === "*" && Array.isArray(current)) {
			const rest = `/${segments.slice(index + 1).join("/")}`;
			return current.flatMap((item) => {
				const resolved = segments.length > index + 1 ? resolvePointer(item, rest) : item;
				return Array.isArray(resolved) ? resolved : [resolved];
			});
		}
		if (current === null || typeof current !== "object") throw new JmapError("invalidResultReference", `Path ${path} not found`);
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** Replace `#arg` result references with values from earlier responses. */
function resolveReferences(args: Record<string, unknown>, responses: JmapInvocation[]): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (!key.startsWith("#")) {
			resolved[key] = value;
			continue;
		}
		const ref = value as { resultOf: string; name: string; path: string };
		const source = responses.find(([name, , callId]) => callId === ref.resultOf && name === ref.name);
		if (!source) throw new JmapError("invalidResultReference", `No response ${ref.name} for call ${ref.resultOf}`);
		resolved[key.slice(1)] = resolvePointer(source[1], ref.path);
	}
	return resolved;
}

/** Client creation ids (`#draft1`) become server ids once the create has run. */
function resolveCreatedIds(args: Record<string, unknown>, createdIds: Record<string, string>): Record<string, unknown> {
	const walk = (value: unknown): unknown => {
		if (typeof value === "string" && value.startsWith("#") && createdIds[value.slice(1)]) return createdIds[value.slice(1)];
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
		return value;
	};
	return walk(args) as Record<string, unknown>;
}

export async function processRequest(ctx: JmapContext, request: JmapRequest): Promise<JmapResponse> {
	const responses: JmapInvocation[] = [];
	Object.assign(ctx.createdIds, request.createdIds ?? {});

	for (const [name, rawArgs, callId] of request.methodCalls) {
		const handler = METHODS[name];
		if (!handler) {
			responses.push(["error", { type: "unknownMethod" }, callId]);
			continue;
		}
		try {
			const args = resolveCreatedIds(resolveReferences(rawArgs ?? {}, responses), ctx.createdIds);
			if (args.accountId !== undefined && args.accountId !== ctx.accountId && name !== "Core/echo") {
				responses.push(["error", { type: "accountNotFound" }, callId]);
				continue;
			}
			const result = await handler(ctx, args);
			if ("type" in result && typeof result.type === "string" && !("accountId" in result) && !("list" in result)) {
				responses.push(["error", result, callId]);
				continue;
			}
			const { __destroyedEmails, ...clean } = result as Record<string, unknown> & { __destroyedEmails?: string[] };
			responses.push([name, clean, callId]);
			// A successful submission removed the draft: report it the way RFC 8621 §7.5 describes.
			if (name === "EmailSubmission/set" && __destroyedEmails?.length) {
				responses.push(["Email/set", { accountId: ctx.accountId, oldState: clean.oldState, newState: clean.newState, updated: {}, destroyed: __destroyedEmails, created: {} }, callId]);
			}
		} catch (error) {
			if (error instanceof JmapError) {
				responses.push(["error", error.toMethodError(), callId]);
			} else {
				console.error(`JMAP ${name} failed`, error);
			// error.message can embed SQL text with bound parameters; the client
			// only needs the logged detail, not the query.
			responses.push(["error", { type: "serverFail", description: "The method failed on the server" }, callId]);
			}
		}
	}

	return { methodResponses: responses, createdIds: Object.keys(ctx.createdIds).length ? ctx.createdIds : undefined, sessionState: await sessionState(ctx) };
}

export async function sessionState(ctx: JmapContext): Promise<string> {
	return getEmailState(ctx);
}

export function validateRequest(body: unknown): JmapRequest {
	if (!body || typeof body !== "object") throw new JmapError("notRequest");
	const request = body as Partial<JmapRequest>;
	if (!Array.isArray(request.using) || !Array.isArray(request.methodCalls)) throw new JmapError("notRequest");
	for (const capability of request.using) {
		const name = String(capability);
		// A client may list optional IETF extension capabilities on every request, even ones it never
		// calls into, and RFC 8620 §3.3 lets it do that. Ignoring an unimplemented extension only
		// pushes the failure to its method calls, which already answer `unknownMethod`. Capability
		// URNs from any other namespace are a real mismatch between the client and this server.
		if (SUPPORTED_CAPABILITIES.has(name) || name.startsWith(JMAP_CAPABILITY_NAMESPACE)) continue;
		throw new JmapError("unknownCapability", name);
	}
	if (request.methodCalls.length > LIMITS.maxCallsInRequest) throw new JmapError("limit", "Too many method calls", { limit: "maxCallsInRequest" });
	for (const call of request.methodCalls) {
		if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || typeof call[2] !== "string") throw new JmapError("notRequest");
	}
	return request as JmapRequest;
}
