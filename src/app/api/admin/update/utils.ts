import { NextResponse } from "next/server";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isNodeRuntime } from "@/lib/runtime";
import type {
  GitHubContentResponse,
  GitHubRepositoryResponse,
  GitHubWorkflowDispatchResponse,
  PackageMetadata,
  UpdateChannel,
  UpdateConfigurationItem,
  UpdateDispatchConfig,
  UpdateStatus,
} from "./types";
import packageMetadata from "../../../../../package.json";
import { commitsBehind, shouldRetryGitHubAnonymously, UPDATE_SOURCE_REPOSITORY } from "./github-utils";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const UPDATE_WORKFLOW = "deploy-update.yml";

export async function authorizeAdminRequest(request: Request) {
  const env = getEnv();
  let user: Awaited<ReturnType<typeof requireUser>>;

  try {
    user = await requireUser(env, request);
  } catch {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  try {
    assertPrimaryAdmin(user);
  } catch {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { env };
}

function getDispatchConfig(env: CloudflareEnv): UpdateDispatchConfig {
  const token = env.GITHUB_UPDATE_TOKEN?.trim();
  const repository = env.GITHUB_UPDATE_REPO?.trim();
  const ref = env.GITHUB_UPDATE_REF?.trim();

  if (!token) {
    throw new Error("GITHUB_UPDATE_TOKEN must be configured");
  }

  if (!repository) {
    throw new Error(
      "GITHUB_UPDATE_REPO must be configured as owner/repository",
    );
  }

  return { token, repository, ref: ref || undefined };
}

function getUpdateConfiguration(env: CloudflareEnv): UpdateConfigurationItem[] {
  return [
    {
      name: "GITHUB_UPDATE_TOKEN",
      configured: !!env.GITHUB_UPDATE_TOKEN?.trim(),
    },
    {
      name: "GITHUB_UPDATE_REPO",
      configured: !!env.GITHUB_UPDATE_REPO?.trim(),
    },
  ];
}

async function sendGitHub<T>(
  path: string,
  init: RequestInit | undefined,
  authenticated: boolean,
): Promise<{ data?: T; response: Response }> {
  const env = getEnv();
  const token = env.GITHUB_UPDATE_TOKEN?.trim();
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "mailflare");
  headers.set("Content-Type", "application/json");
  headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
  if (authenticated && token) headers.set("Authorization", `Bearer ${token}`);
  else headers.delete("Authorization");

  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    cache: "no-store",
    ...init,
    headers,
  });

  if (response.statusText === "Forbidden") {
    return { response, data: { error: response.statusText } as T };
  }
  if (response.status === 204) return { response };

  const text = await response.text();
  if (!text) return { response };
  try {
    return { response, data: JSON.parse(text) as T };
  } catch {
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }
}

async function githubRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data?: T; response: Response }> {
  const authed = await sendGitHub<T>(path, init, true);
  if (!shouldRetryGitHubAnonymously(path, authed.response.status)) return authed;
  return sendGitHub<T>(path, init, false);
}

async function getDispatchRef(config: UpdateDispatchConfig): Promise<string> {
  if (config.ref) return config.ref;

  const { data, response } = await githubRequest<GitHubRepositoryResponse>(
    `/repos/${config.repository}`,
  );
  if (!response.ok || !data?.default_branch) {
    throw new Error(
      data?.message ?? "Could not determine the repository default branch",
    );
  }

  return data.default_branch;
}

function parseVersion(version: string): number[] {
  const normalized = version.trim().replace(/^v/, "").split("-")[0];
  const parts = normalized.split(".");

  if (
    parts.length < 1 ||
    parts.length > 3 ||
    parts.some((part) => !/^\d+$/.test(part))
  ) {
    throw new Error(`Invalid application version: ${version}`);
  }

  return [0, 1, 2].map((index) => Number(parts[index] ?? 0));
}

function isNewerVersion(
  targetVersion: string,
  currentVersion: string,
): boolean {
  const target = parseVersion(targetVersion);
  const current = parseVersion(currentVersion);

  for (let index = 0; index < target.length; index += 1) {
    if (target[index] !== current[index]) {
      return target[index] > current[index];
    }
  }

  return false;
}

async function getTargetVersion(): Promise<string> {
  // const sourceConfig: UpdateDispatchConfig = {
  //   repository: UPDATE_SOURCE_REPOSITORY,
  //   token,
  // };
  // const ref = await getDispatchRef(sourceConfig);
  const { data, response } = await githubRequest<GitHubContentResponse>(
    `/repos/${UPDATE_SOURCE_REPOSITORY}/contents/package.json`,
  );

  if (!response.ok || !data?.content || data.encoding !== "base64") {
    throw new Error(
      data?.message ?? "Could not read the target repository version",
    );
  }

  const dataStr = atob(data.content.replace(/\n/g, ""));

  const packageJson = JSON.parse(dataStr) as PackageMetadata;
  if (!packageJson.version) {
    throw new Error("The target repository package.json has no version");
  }

  return packageJson.version;
}

async function listCommitShas(repository: string, ref: string): Promise<string[]> {
  const shas: string[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const { data, response } = await githubRequest<
      { sha?: string }[] | { message?: string }
    >(
      `/repos/${repository}/commits?sha=${encodeURIComponent(ref)}&per_page=100&page=${page}`,
    );
    if (!response.ok || !Array.isArray(data)) {
      const message = data && !Array.isArray(data) ? data.message : undefined;
      throw new Error(message ?? `Could not read commits from ${repository}`);
    }
    for (const commit of data) {
      if (commit.sha) shas.push(commit.sha);
    }
    if (data.length < 100) break;
  }
  return shas;
}

async function getCommitStatus(env: CloudflareEnv) {
  const config = getDispatchConfig(env);
  const ref = await getDispatchRef(config);
  const { data: upstream, response: upstreamResponse } =
    await githubRequest<GitHubRepositoryResponse>(
      `/repos/${UPDATE_SOURCE_REPOSITORY}`,
    );
  if (!upstreamResponse.ok) {
    throw new Error(
      upstream?.message ?? "Could not read the upstream repository",
    );
  }
  const branch = upstream?.default_branch ?? "main";
  const [installationShas, upstreamShas] = await Promise.all([
    listCommitShas(config.repository, ref),
    listCommitShas(UPDATE_SOURCE_REPOSITORY, branch),
  ]);
  const behindBy = commitsBehind(upstreamShas, new Set(installationShas));
  if (behindBy === null || !upstreamShas[0]) {
    throw new Error(
      "Could not find a shared commit with the upstream repository",
    );
  }
  return { behindBy, sha: upstreamShas[0] };
}

export async function getUpdateStatus(
  env: CloudflareEnv,
  channel: UpdateChannel = "release",
): Promise<UpdateStatus> {
  const currentVersion = packageMetadata.version;

  if (isNodeRuntime(env)) {
    return { configuration: [], configured: false, currentVersion };
  }

  const configuration = getUpdateConfiguration(env);
  const configured = configuration.every((item) => item.configured);

  if (!configured) {
    return {
      configuration,
      configured,
      currentVersion,
    };
  }

  getDispatchConfig(env);

  if (channel === "commit") {
    const { behindBy, sha } = await getCommitStatus(env);
    return {
      available: behindBy > 0,
      channel,
      commitsBehind: behindBy,
      configuration,
      configured,
      currentVersion,
      repository: UPDATE_SOURCE_REPOSITORY,
      targetVersion: sha.slice(0, 7),
      targetCommit: sha,
    };
  }

  const targetVersion = await getTargetVersion();

  return {
    available: isNewerVersion(targetVersion, currentVersion),
    channel,
    configuration,
    configured,
    currentVersion,
    repository: UPDATE_SOURCE_REPOSITORY,
    targetVersion,
  };
}

export async function dispatchUpdateWorkflow() {
  const env = getEnv();

  const config = getDispatchConfig(env);
  const repository = config.repository;
  const ref = await getDispatchRef(config);

  // Dispatch by workflow file name; GitHub accepts it in place of the numeric
  // workflow id, so this does not depend on the workflow's display name.
  const { data, response } =
    await githubRequest<GitHubWorkflowDispatchResponse>(
      `/repos/${repository}/actions/workflows/${UPDATE_WORKFLOW}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref }),
      },
    );

  if (!response.ok) {
    throw new Error(
      data?.message ??
        `GitHub returned HTTP ${response.status} dispatching ${UPDATE_WORKFLOW} in ${repository}`,
    );
  }

  return {
    ref,
    repository,
    runUrl: data?.html_url,
    workflowRunId: data?.workflow_run_id,
  };
}
