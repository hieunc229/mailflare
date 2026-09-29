import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GET as listDomains, POST as createDomain } from "@/app/api/v1/domains/route";
import { GET as getDomain, DELETE as deleteDomain } from "@/app/api/v1/domains/[id]/route";
import { GET as getDomainDns } from "@/app/api/v1/domains/[id]/dns/route";
import { POST as setupDomainDns } from "@/app/api/v1/domains/[id]/dns/setup/route";
import { GET as listAccounts, POST as createAccount } from "@/app/api/v1/accounts/route";
import { GET as getAccount, PATCH as updateAccount } from "@/app/api/v1/accounts/[id]/route";
import { GET as listMailboxes, POST as createMailbox } from "@/app/api/v1/mailboxes/route";
import { GET as getMailbox, PATCH as updateMailbox, DELETE as deleteMailbox } from "@/app/api/v1/mailboxes/[id]/route";
import type { McpPrincipal } from "./types";

const adminInput = z.object({
	action: z.string(),
	id: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
});

function result(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

async function responseResult(response: Response) {
	const data: unknown = await response.json().catch(() => ({ error: "Request failed" }));
	return result({ status: response.status, data }, !response.ok);
}

function adminRequest(baseUrl: string, path: string, authorization: string, method = "GET", data?: Record<string, unknown>) {
	return new Request(new URL(path, baseUrl), {
		method,
		headers: { Authorization: authorization, ...(data ? { "Content-Type": "application/json" } : {}) },
		...(data ? { body: JSON.stringify(data) } : {}),
	});
}

export function registerAdminMcpTools(server: McpServer, principal: McpPrincipal, baseUrl: string, authorization: string) {
	if (principal.scopes.includes("domains")) server.registerTool("manage_domains", {
		description: "List, inspect, create, or delete domains and inspect or set up DNS records. Actions: list, get, create, delete, dns, setup_dns. Pass id for a domain action and data for create or setup_dns.",
		inputSchema: adminInput,
	}, async ({ action, id, data }) => {
		if (!principal.scopes.includes("domains")) return result({ error: "Permission denied" }, true);
		if (["get", "delete", "dns", "setup_dns"].includes(action) && !id) return result({ error: "Domain id required" }, true);
		const path = id ? `/api/v1/domains/${encodeURIComponent(id)}` : "/api/v1/domains";
		try {
			switch (action) {
				case "list": return responseResult(await listDomains(adminRequest(baseUrl, path, authorization)));
				case "get": return responseResult(await getDomain(adminRequest(baseUrl, path, authorization), { params: Promise.resolve({ id: id! }) }));
				case "create": return responseResult(await createDomain(adminRequest(baseUrl, path, authorization, "POST", data ?? {})));
				case "delete": return responseResult(await deleteDomain(adminRequest(baseUrl, path, authorization, "DELETE"), { params: Promise.resolve({ id: id! }) }));
				case "dns": return responseResult(await getDomainDns(adminRequest(baseUrl, `${path}/dns`, authorization), { params: Promise.resolve({ id: id! }) }));
				case "setup_dns": return responseResult(await setupDomainDns(adminRequest(baseUrl, `${path}/dns/setup`, authorization, "POST", data ?? {}), { params: Promise.resolve({ id: id! }) }));
				default: return result({ error: "Unknown action" }, true);
			}
		} catch (error) { return result({ error: error instanceof Error ? error.message : "Domain action failed" }, true); }
	});

	if (principal.scopes.includes("accounts")) server.registerTool("manage_accounts", {
		description: "List, inspect, create, or update managed accounts. Actions: list, get, create, update. Pass id for get or update and data for create or update. For create, data accepts username, domainId, password, role?, useAllDomains? (defaults to true for compatibility), and aliases?: [{ domainId, localPart }]. Set useAllDomains to false to assign only the primary address and explicit aliases. Requires a Team license.",
		inputSchema: adminInput,
	}, async ({ action, id, data }) => {
		if (!principal.scopes.includes("accounts")) return result({ error: "Permission denied" }, true);
		if (["get", "update"].includes(action) && !id) return result({ error: "Account id required" }, true);
		const path = id ? `/api/v1/accounts/${encodeURIComponent(id)}` : "/api/v1/accounts";
		try {
			switch (action) {
				case "list": return responseResult(await listAccounts(adminRequest(baseUrl, path, authorization)));
				case "get": return responseResult(await getAccount(adminRequest(baseUrl, path, authorization), { params: Promise.resolve({ id: id! }) }));
				case "create": return responseResult(await createAccount(adminRequest(baseUrl, path, authorization, "POST", data ?? {})));
				case "update": return responseResult(await updateAccount(adminRequest(baseUrl, path, authorization, "PATCH", data ?? {}), { params: Promise.resolve({ id: id! }) }));
				default: return result({ error: "Unknown action" }, true);
			}
		} catch (error) { return result({ error: error instanceof Error ? error.message : "Account action failed" }, true); }
	});

	if (principal.scopes.includes("mailboxes")) server.registerTool("manage_mailboxes", {
		description: "List, inspect, create, update, or delete mailboxes. These actions manage mailbox configuration, not message content. Actions: list, get, create, update, delete. Pass id for get, update, or delete and data for create or update.",
		inputSchema: adminInput,
	}, async ({ action, id, data }) => {
		if (!principal.scopes.includes("mailboxes")) return result({ error: "Permission denied" }, true);
		if (["get", "update", "delete"].includes(action) && !id) return result({ error: "Mailbox id required" }, true);
		const path = id ? `/api/v1/mailboxes/${encodeURIComponent(id)}` : "/api/v1/mailboxes";
		try {
			switch (action) {
				case "list": return responseResult(await listMailboxes(adminRequest(baseUrl, path, authorization)));
				case "get": return responseResult(await getMailbox(adminRequest(baseUrl, path, authorization), { params: Promise.resolve({ id: id! }) }));
				case "create": return responseResult(await createMailbox(adminRequest(baseUrl, path, authorization, "POST", data ?? {})));
				case "update": return responseResult(await updateMailbox(adminRequest(baseUrl, path, authorization, "PATCH", data ?? {}), { params: Promise.resolve({ id: id! }) }));
				case "delete": return responseResult(await deleteMailbox(adminRequest(baseUrl, path, authorization, "DELETE"), { params: Promise.resolve({ id: id! }) }));
				default: return result({ error: "Unknown action" }, true);
			}
		} catch (error) { return result({ error: error instanceof Error ? error.message : "Mailbox action failed" }, true); }
	});
}
