export interface UpdateConfigurationItem {
	configured: boolean;
	name: "GITHUB_UPDATE_REPO" | "GITHUB_UPDATE_TOKEN";
}

export interface UpdateStatusResponse {
	autoUpdate?: boolean;
	channel?: "release" | "commit";
	commitsBehind?: number;
	available?: boolean;
	configuration?: UpdateConfigurationItem[];
	configured?: boolean;
	currentVersion?: string;
	error?: string;
	repository?: string;
	targetVersion?: string;
}

export interface UpdateWorkflowResponse {
	error?: string;
	ok?: boolean;
	ref?: string;
	repository?: string;
	runUrl?: string;
	workflowRunId?: number;
}

export interface MigrationStatusResponse {
	applied?: string[];
	error?: string;
	pending: string[];
	ready: boolean;
	unknown: string[];
}
