export interface GitHubRepositoryResponse {
	default_branch?: string;
	message?: string;
}

export interface GitHubContentResponse {
	content?: string;
	encoding?: string;
	message?: string;
}

export interface GitHubWorkflowDispatchResponse {
	workflow_run_id?: number;
	html_url?: string;
	message?: string;
}

export interface PackageMetadata {
	version?: string;
}

export interface UpdateConfigurationItem {
	configured: boolean;
	name: "GITHUB_UPDATE_REPO" | "GITHUB_UPDATE_TOKEN";
}

export interface UpdateDispatchConfig {
	repository: string;
	ref?: string;
	token: string;
}

export type UpdateChannel = "release" | "commit";

export interface GitHubCompareResponse {
	behind_by?: number;
	base_commit?: { sha?: string };
	message?: string;
}

export interface UpdateStatus {
	channel?: UpdateChannel;
	commitsBehind?: number;
	targetCommit?: string;
	autoUpdate?: boolean;
	available?: boolean;
	configuration: UpdateConfigurationItem[];
	configured: boolean;
	currentVersion: string;
	repository?: string;
	targetVersion?: string;
}
