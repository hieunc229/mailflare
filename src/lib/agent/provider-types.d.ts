export type AgentProviderKind = "cloudflare" | "compatible";
export type AgentProviderPreset = "openai" | "anthropic" | "openrouter" | "groq" | "custom";
export type AgentModelRates = { input: number | null; output: number | null };

export type AgentProviderConfig = {
	provider: AgentProviderKind;
	preset: AgentProviderPreset;
	baseUrl: string;
	apiKey: string;
	model: string;
	models: string[];
	rates: Record<string, AgentModelRates>;
	source: "saved" | "environment" | "default";
};

export type AgentProviderPublicConfig = Omit<AgentProviderConfig, "apiKey"> & {
	hasApiKey: boolean;
	configured: boolean;
};

// rates are USD per 1M tokens, present only when the provider's own model catalog publishes pricing.
export type AgentModelOption = { id: string; name: string; rates?: AgentModelRates };
