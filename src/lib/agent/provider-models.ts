import type { AgentModelOption, AgentModelRates, AgentProviderPreset } from "./provider-types";
import { getAgentProviderConfig, resolveAgentBaseUrl } from "./provider";

export const CLOUDFLARE_TOOL_MODELS: AgentModelOption[] = [
	{ id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5" },
	{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B" },
	{ id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B" },
];

function perMillion(value: unknown, perToken: boolean): number | null {
	const price = typeof value === "string" ? Number(value) : value;
	if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
	return Number((perToken ? price * 1_000_000 : price).toPrecision(10));
}

// Workers AI lists prices as [{ unit: "per M input tokens", price, currency: "USD" }, ...] under properties.
function cloudflareRates(properties: unknown): AgentModelRates | undefined {
	if (!Array.isArray(properties)) return undefined;
	const entry = properties.find((item) => item && typeof item === "object" && item.property_id === "price");
	const prices: { unit?: unknown; price?: unknown; currency?: unknown }[] = Array.isArray(entry?.value) ? entry.value : [];
	const find = (kind: "input" | "output") => prices.find((item) => item?.currency === "USD" && /per m/i.test(String(item.unit)) && String(item.unit).toLowerCase().includes(kind));
	const input = perMillion(find("input")?.price, false);
	const output = perMillion(find("output")?.price, false);
	return input === null || output === null ? undefined : { input, output };
}

// OpenRouter publishes pricing.prompt / pricing.completion as USD per token (strings). Other providers omit pricing.
function openRouterRates(pricing: unknown): AgentModelRates | undefined {
	if (!pricing || typeof pricing !== "object") return undefined;
	const input = perMillion((pricing as { prompt?: unknown }).prompt, true);
	const output = perMillion((pricing as { completion?: unknown }).completion, true);
	return input === null || output === null ? undefined : { input, output };
}

export async function listCloudflareAgentModels(env: CloudflareEnv): Promise<{ models: AgentModelOption[]; source: "catalog" | "suggested" }> {
	if (!env.CF_ACCOUNT_ID || !env.CF_TOKEN) return { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" };
	try {
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/ai/models/search?task=Text%20Generation`, { headers: { Authorization: `Bearer ${env.CF_TOKEN}` }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
		if (!response.ok) throw new Error("Catalog unavailable");
		const json = await response.json() as { result?: { name?: unknown; description?: unknown; task?: unknown; properties?: unknown }[] };
		const models = (json.result ?? []).filter((item) => typeof item.name === "string" && item.name.startsWith("@cf/") && (item.task === "Text Generation" || item.task === "text-generation" || !item.task)).map((item) => ({ id: item.name as string, name: item.name as string, rates: cloudflareRates(item.properties) })).slice(0, 200);
		return models.length ? { models, source: "catalog" } : { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" };
	} catch { return { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" }; }
}

export async function listCompatibleAgentModels(env: CloudflareEnv, input: { preset: AgentProviderPreset; baseUrl: string; apiKey?: string }) {
	const baseUrl = resolveAgentBaseUrl(input.preset, input.baseUrl);
	const saved = await getAgentProviderConfig(env);
	const key = input.apiKey?.trim() || (saved.provider === "compatible" && saved.preset === input.preset && saved.baseUrl === baseUrl ? saved.apiKey : "");
	if (!key) throw new Error("Enter an API key to load models");
	// Anthropic's model list is its native API: it needs a version header and pages at 20 by default.
	const anthropic = new URL(baseUrl).hostname === "api.anthropic.com";
	const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
	if (anthropic) headers["anthropic-version"] = "2023-06-01";
	const response = await fetch(`${baseUrl}/models${anthropic ? "?limit=1000" : ""}`, { headers, signal: AbortSignal.timeout(10_000), redirect: "manual" });
	if (!response.ok) throw new Error(`Model list request failed (${response.status})`);
	const json = await response.json() as { data?: { id?: unknown; name?: unknown; display_name?: unknown; pricing?: unknown }[] };
	const models = (json.data ?? []).filter((item) => typeof item.id === "string" && item.id.length <= 200).map((item) => ({ id: item.id as string, name: typeof item.name === "string" ? item.name : typeof item.display_name === "string" ? item.display_name : item.id as string, rates: input.preset === "openrouter" ? openRouterRates(item.pricing) : undefined })).slice(0, 2_000).sort((a, b) => a.name.localeCompare(b.name));
	if (!models.length) throw new Error("Provider returned no models");
	return { models, source: "catalog" as const };
}
