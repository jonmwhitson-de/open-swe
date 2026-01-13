import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { LocalDockerSandboxProvider } from "@openswe/sandbox-docker";
import type {
  LocalDockerSandboxOptions,
  LocalDockerSandboxResources,
  WritableMount,
} from "@openswe/sandbox-docker";
import type { SandboxHandle, SandboxProvider } from "@openswe/sandbox-core";
import { GraphConfig, TargetRepository } from "@openswe/shared/open-swe/types";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import { SANDBOX_DOCKER_IMAGE } from "../constants.js";
import { createLogger, LogLevel } from "./logger.js";
import { getWorkspacePathFromConfig } from "./workspace.js";
import { allocatePortMappings, type PortMapping } from "./port-utils.js";

const logger = createLogger(LogLevel.INFO, "Sandbox");

type SandboxProviderFactory = (
  options: LocalDockerSandboxOptions,
) => SandboxProvider;

const DEFAULT_REPO_ROOT = "/workspace";
const SANDBOX_MOUNT_PATH = "/workspace/src";
const DEFAULT_COMMIT_MESSAGE = "OpenSWE auto-commit";
const DEFAULT_COMMIT_AUTHOR_NAME = "Open SWE";
const DEFAULT_COMMIT_AUTHOR_EMAIL = "opensource@langchain.dev";
const DEFAULT_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_PIDS_LIMIT = 512;
const DEFAULT_COMMAND_TIMEOUT_SEC = 900;

const commitCounters = new Map<string, number>();

function buildContainerName(repoName: string): string {
  const normalizedBase = repoName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  const base = normalizedBase || "sandbox";
  const truncatedBase = base.length > 40 ? base.slice(0, 40) : base;
  const suffix = randomUUID().split("-")[0];
  const candidate = `openswe-${truncatedBase}-${suffix}`;
  const trimmed = candidate.replace(/[^a-z0-9_.-]/g, "-");
  const shortened = trimmed.length > 63 ? trimmed.slice(0, 63) : trimmed;
  const sanitized = shortened.replace(/[-.]+$/g, "").replace(/^[-.]+/, "");
  return sanitized || `openswe-sandbox-${suffix}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function parsePositiveFloat(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

const SANDBOX_MEMORY_LIMIT_BYTES = parsePositiveInt(
  process.env.LOCAL_SANDBOX_MEMORY,
  DEFAULT_MEMORY_LIMIT_BYTES,
);

const SANDBOX_CPU_COUNT = parsePositiveFloat(
  process.env.LOCAL_SANDBOX_CPUS,
  DEFAULT_CPU_COUNT,
);

const SANDBOX_PIDS_LIMIT = parsePositiveInt(
  process.env.LOCAL_SANDBOX_PIDS,
  DEFAULT_PIDS_LIMIT,
);

const rawNetworkSetting = process.env.LOCAL_SANDBOX_NETWORK?.trim();
const normalizedNetworkSetting = rawNetworkSetting?.toLowerCase();
const SANDBOX_NETWORK_ENABLED = Boolean(
  rawNetworkSetting &&
    !["none", "false", "off", "disable", "disabled"].includes(
      normalizedNetworkSetting ?? "",
    ),
);
const SANDBOX_NETWORK_MODE = SANDBOX_NETWORK_ENABLED
  ? rawNetworkSetting
  : undefined;

const SANDBOX_COMMAND_TIMEOUT_SEC = parsePositiveInt(
  process.env.LOCAL_SANDBOX_TIMEOUT_SEC,
  DEFAULT_COMMAND_TIMEOUT_SEC,
);

/**
 * Default ports to expose from the sandbox container for preview functionality.
 * Common development server ports: 3000 (React/Next.js), 5173 (Vite), 8000 (Django), 8080 (generic)
 */
const DEFAULT_EXPOSED_PORTS = [3000, 5173, 8000, 8080, 4000, 5000];

function parseExposedPorts(envValue: string | undefined): number[] {
  if (!envValue) return DEFAULT_EXPOSED_PORTS;
  const ports = envValue
    .split(",")
    .map((p) => parseInt(p.trim(), 10))
    .filter((p) => !isNaN(p) && p > 0 && p < 65536);
  return ports.length > 0 ? ports : DEFAULT_EXPOSED_PORTS;
}

const SANDBOX_EXPOSED_PORTS = parseExposedPorts(process.env.LOCAL_SANDBOX_EXPOSED_PORTS);

const COMMIT_AUTHOR_NAME =
  process.env.GIT_AUTHOR_NAME?.trim() || DEFAULT_COMMIT_AUTHOR_NAME;
const COMMIT_AUTHOR_EMAIL =
  process.env.GIT_AUTHOR_EMAIL?.trim() || DEFAULT_COMMIT_AUTHOR_EMAIL;

const COMMIT_COMMITTER_NAME =
  process.env.GIT_COMMITTER_NAME?.trim() || COMMIT_AUTHOR_NAME;
const COMMIT_COMMITTER_EMAIL =
  process.env.GIT_COMMITTER_EMAIL?.trim() || COMMIT_AUTHOR_EMAIL;

const SANDBOX_GIT_USER_NAME = COMMIT_COMMITTER_NAME;
const SANDBOX_GIT_USER_EMAIL = COMMIT_COMMITTER_EMAIL;

const SKIP_CI_UNTIL_LAST_COMMIT = parseBoolean(
  process.env.SKIP_CI_UNTIL_LAST_COMMIT,
  true,
);

function buildCommitMessage(repoPath: string): string {
  const count = (commitCounters.get(repoPath) ?? 0) + 1;
  commitCounters.set(repoPath, count);
  const suffix = SKIP_CI_UNTIL_LAST_COMMIT ? " [skip ci]" : "";
  return `${DEFAULT_COMMIT_MESSAGE} #${count}${suffix}`;
}

async function runGitCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_COMMITTER_EMAIL,
  };

  try {
    const { stdout, stderr } = await execFile("git", args, { cwd, env });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = String((error as { stdout?: string }).stdout ?? "");
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      return { stdout, stderr };
    }
    throw error;
  }
}

async function commitHostChanges(repoPath: string): Promise<void> {
  const startedAt = Date.now();
  logger.info("Checking host repository for changes", { repoPath });
  try {
    const status = await runGitCommand(["status", "--porcelain"], repoPath);
    if (!status.stdout.trim()) {
      logger.info("No host changes detected", {
        repoPath,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await runGitCommand(["add", "--all"], repoPath);
    const message = buildCommitMessage(repoPath);
    const commitResult = await runGitCommand(
      ["commit", "-m", message],
      repoPath,
    );

    if (commitResult.stderr.trim()) {
      logger.info("Git commit completed with messages", {
        repoPath,
        stderr: commitResult.stderr,
      });
    }

    logger.info("Committed sandbox changes", {
      repoPath,
      message,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error("Failed to commit sandbox changes", {
      repoPath,
      error,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function configureContainerGit(
  handle: SandboxHandle,
  repoPath: string,
): Promise<void> {
  try {
    await handle.process.executeCommand(
      `git config --global --add safe.directory ${repoPath}`,
      repoPath,
    );
    if (SANDBOX_GIT_USER_NAME) {
      await handle.process.executeCommand(
        `git config --global user.name "${SANDBOX_GIT_USER_NAME}"`,
        repoPath,
      );
    }
    if (SANDBOX_GIT_USER_EMAIL) {
      await handle.process.executeCommand(
        `git config --global user.email "${SANDBOX_GIT_USER_EMAIL}"`,
        repoPath,
      );
    }
  } catch (error) {
    logger.warn("Failed to configure git inside sandbox", {
      repoPath,
      error,
    });
  }
}

let sandboxProviderFactory: SandboxProviderFactory = (options) =>
  new LocalDockerSandboxProvider(options);

export function setSandboxProviderFactory(
  factory: SandboxProviderFactory,
): void {
  sandboxProviderFactory = factory;
}

export function resetSandboxProviderFactory(): void {
  sandboxProviderFactory = (options) => new LocalDockerSandboxProvider(options);
}

export type SandboxProcess = SandboxHandle["process"];
export type Sandbox = SandboxHandle;

interface SandboxMetadata {
  provider: SandboxProvider;
  hostRepoPath?: string;
  hostMountPath?: string;
  workspacePath?: string;
  containerName?: string;
  containerRepoPath: string;
  commitOnChange: boolean;
  commandTimeoutSec: number;
  requestedResources?: LocalDockerSandboxResources;
  appliedResources?: LocalDockerSandboxResources;
  /**
   * Ports exposed from the container for preview functionality.
   * These are the host ports that map to container ports.
   */
  exposedPorts?: number[];
  /**
   * Port mappings from container ports to host ports.
   * Useful when the host port differs from the container port.
   */
  portMappings?: PortMapping[];
}

const sandboxes = new Map<string, Sandbox>();
const sandboxMetadata = new Map<string, SandboxMetadata>();

export function getSandbox(id: string): Sandbox | undefined {
  return sandboxes.get(id);
}

export function getSandboxMetadata(id: string): SandboxMetadata | undefined {
  return sandboxMetadata.get(id);
}

/**
 * Get the primary preview port for a sandbox.
 * Returns the first exposed port, which is typically the main dev server port.
 */
export function getSandboxPreviewPort(id: string): number | undefined {
  const metadata = sandboxMetadata.get(id);
  return metadata?.exposedPorts?.[0];
}

/**
 * Get all exposed ports for a sandbox.
 */
export function getSandboxExposedPorts(id: string): number[] | undefined {
  const metadata = sandboxMetadata.get(id);
  return metadata?.exposedPorts;
}

/**
 * Get port mappings for a sandbox.
 * Returns mappings from container ports to host ports.
 */
export function getSandboxPortMappings(id: string): PortMapping[] | undefined {
  const metadata = sandboxMetadata.get(id);
  return metadata?.portMappings;
}

/**
 * Get the host port for a given container port in a sandbox.
 * Useful for finding where a specific container service is accessible.
 */
export function getHostPortForContainer(
  sandboxId: string,
  containerPort: number,
): number | undefined {
  const mappings = getSandboxPortMappings(sandboxId);
  const mapping = mappings?.find((m) => m.containerPort === containerPort);
  return mapping?.hostPort;
}

/**
 * Query Docker directly to get port mappings for a container.
 * This is useful when the in-memory sandbox metadata is lost (e.g., after backend restart).
 * @param containerId - The Docker container ID or name
 * @returns Promise resolving to port mappings, or undefined if container not found
 */
export async function getPortMappingsFromDocker(
  containerId: string,
): Promise<PortMapping[] | undefined> {
  try {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker();

    const container = docker.getContainer(containerId);
    const inspectData = await container.inspect();

    if (!inspectData.NetworkSettings?.Ports) {
      return undefined;
    }

    const mappings: PortMapping[] = [];
    const ports = inspectData.NetworkSettings.Ports;

    for (const [containerPortKey, hostBindings] of Object.entries(ports)) {
      if (!hostBindings || hostBindings.length === 0) continue;

      // containerPortKey is like "3000/tcp"
      const containerPort = parseInt(containerPortKey.split("/")[0], 10);
      if (isNaN(containerPort)) continue;

      // Get the first host binding
      const hostPort = parseInt(hostBindings[0].HostPort, 10);
      if (isNaN(hostPort)) continue;

      mappings.push({ containerPort, hostPort });
    }

    logger.info("Retrieved port mappings from Docker", {
      containerId,
      mappings: mappings.map((m) => `${m.containerPort}->${m.hostPort}`),
    });

    return mappings.length > 0 ? mappings : undefined;
  } catch (error) {
    logger.debug("Failed to get port mappings from Docker", {
      containerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function resolveRepoName(hostRepoPath?: string, provided?: string): string {
  if (provided) return provided;
  if (hostRepoPath) {
    const normalized = path.resolve(hostRepoPath);
    return path.basename(normalized) || `sandbox-${randomUUID()}`;
  }
  return `sandbox-${randomUUID()}`;
}

export interface CreateSandboxOptions {
  hostRepoPath?: string;
  workspacePath?: string;
  repoName?: string;
  containerRepoPath?: string;
  commitOnChange?: boolean;
  commandTimeoutSec?: number;
}

export async function createDockerSandbox(
  image: string,
  options: CreateSandboxOptions = {},
): Promise<Sandbox> {
  const startedAt = Date.now();
  const resolvedHostRepoPath = options.hostRepoPath
    ? path.resolve(options.hostRepoPath)
    : undefined;
  const resolvedWorkspacePath = options.workspacePath
    ? path.resolve(options.workspacePath)
    : undefined;

  const mountSourcePath = resolvedWorkspacePath ?? resolvedHostRepoPath;
  const repoName = resolveRepoName(mountSourcePath, options.repoName);
  const containerRepoPath =
    options.containerRepoPath ??
    (resolvedWorkspacePath ? SANDBOX_MOUNT_PATH : path.join(DEFAULT_REPO_ROOT, repoName));
  const commitOnChange = options.commitOnChange ?? false;
  const commandTimeoutSec =
    options.commandTimeoutSec ?? SANDBOX_COMMAND_TIMEOUT_SEC;

  const hostCommitPath = commitOnChange ? mountSourcePath : undefined;

  const writableMounts: WritableMount[] | undefined = hostCommitPath
    ? [{ source: hostCommitPath, target: containerRepoPath }]
    : undefined;

  // Allocate available ports dynamically to avoid conflicts
  const portMappings = await allocatePortMappings(SANDBOX_EXPOSED_PORTS);
  const allocatedHostPorts = portMappings.map((m) => m.hostPort);

  if (portMappings.length < SANDBOX_EXPOSED_PORTS.length) {
    logger.warn("Some ports could not be allocated", {
      requested: SANDBOX_EXPOSED_PORTS,
      allocated: allocatedHostPorts,
    });
  }

  const resources: LocalDockerSandboxResources = {
    cpuCount: SANDBOX_CPU_COUNT,
    memoryBytes: SANDBOX_MEMORY_LIMIT_BYTES,
    networkDisabled: !SANDBOX_NETWORK_ENABLED,
    networkMode: SANDBOX_NETWORK_MODE,
    pidsLimit: SANDBOX_PIDS_LIMIT,
    // Use allocated host ports instead of fixed ports
    exposedPorts: allocatedHostPorts,
  };

  const containerName = buildContainerName(repoName);

  const providerOptions: LocalDockerSandboxOptions = {
    defaultMountPath: mountSourcePath ?? process.cwd(),
    writableMounts,
    resources,
    workingDirectory: containerRepoPath,
    ensureMountsExist: true,
    defaultTimeoutSec: SANDBOX_COMMAND_TIMEOUT_SEC,
    containerName,
  };

  const provider = sandboxProviderFactory(providerOptions);
  logger.info("Creating sandbox", {
    image,
    containerName,
    hostMountPath: mountSourcePath,
    containerRepoPath,
    commitOnChange,
  });
  const handle = await provider.createSandbox(image, mountSourcePath);
  const appliedResources = handle.metadata?.appliedResources;
  const requestedResources = handle.metadata?.requestedResources ?? resources;

  logger.info("Created sandbox container", {
    sandboxId: handle.id,
    containerName: handle.metadata?.containerName ?? containerName,
    image,
    hostMountPath: mountSourcePath,
    containerRepoPath,
    resources: {
      requested: {
        cpuCount: requestedResources?.cpuCount,
        memoryBytes: requestedResources?.memoryBytes,
        pidsLimit: requestedResources?.pidsLimit,
      },
      applied: appliedResources,
      networkMode: resources.networkMode,
      networkDisabled: resources.networkDisabled,
    },
    writableMountTargets: writableMounts?.map((mount) => mount.target) ?? [],
    durationMs: Date.now() - startedAt,
  });

  await configureContainerGit(handle, containerRepoPath);

  const sandboxProcess: SandboxProcess = {
    async executeCommand(command, cwd, env, timeoutSec) {
      const effectiveCwd = cwd ?? containerRepoPath;
      const effectiveTimeout = timeoutSec ?? commandTimeoutSec;
      const commandStartedAt = Date.now();
      const result = await handle.process.executeCommand(
        command,
        effectiveCwd,
        env,
        effectiveTimeout,
      );

      logger.info("Sandbox command completed", {
        sandboxId: handle.id,
        command,
        exitCode: result.exitCode ?? 0,
        durationMs: Date.now() - commandStartedAt,
      });

      if (commitOnChange && hostCommitPath && result.exitCode === 0) {
        await commitHostChanges(hostCommitPath);
      }

      return result;
    },
  };

  const sandbox: Sandbox = { id: handle.id, process: sandboxProcess };
  sandboxes.set(sandbox.id, sandbox);

  // Get exposed ports from handle metadata or resources
  const exposedPorts = handle.metadata?.exposedPorts ?? resources.exposedPorts;

  sandboxMetadata.set(sandbox.id, {
    provider,
    hostRepoPath: hostCommitPath,
    hostMountPath: mountSourcePath,
    workspacePath: resolvedWorkspacePath,
    containerName,
    containerRepoPath,
    commitOnChange,
    commandTimeoutSec,
    requestedResources,
    appliedResources,
    exposedPorts,
    portMappings,
  });

  if (exposedPorts && exposedPorts.length > 0) {
    logger.info("Sandbox preview ports configured", {
      sandboxId: sandbox.id,
      exposedPorts,
      portMappings: portMappings.map((m) => `${m.containerPort}->${m.hostPort}`),
    });
  }

  return sandbox;
}

export async function stopSandbox(sandboxId: string): Promise<string> {
  const startedAt = Date.now();
  logger.info("Stopping sandbox", { sandboxId });
  const metadata = sandboxMetadata.get(sandboxId);
  if (metadata?.commitOnChange && metadata.hostRepoPath) {
    await commitHostChanges(metadata.hostRepoPath);
  }

  if (metadata) {
    try {
      await metadata.provider.stopSandbox(sandboxId);
      logger.info("Sandbox stopped", {
        sandboxId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("Failed to stop sandbox", { sandboxId, error });
    }
  }

  return sandboxId;
}

export async function deleteSandbox(sandboxId: string): Promise<boolean> {
  const startedAt = Date.now();
  logger.info("Deleting sandbox", { sandboxId });
  const metadata = sandboxMetadata.get(sandboxId);
  if (metadata?.commitOnChange && metadata.hostRepoPath) {
    await commitHostChanges(metadata.hostRepoPath);
  }

  if (!metadata) {
    return false;
  }

  try {
    const deleted = await metadata.provider.deleteSandbox(sandboxId);
    if (deleted) {
      sandboxes.delete(sandboxId);
      sandboxMetadata.delete(sandboxId);
      logger.info("Sandbox deleted", {
        sandboxId,
        durationMs: Date.now() - startedAt,
      });
    }
    return deleted;
  } catch (error) {
    logger.error("Failed to delete sandbox", { sandboxId, error });
    return false;
  }
}

export async function getSandboxWithErrorHandling(
  sandboxSessionId: string | undefined,
  targetRepository: TargetRepository,
  _branchName: string,
  config: GraphConfig,
): Promise<{
  sandbox: Sandbox;
  codebaseTree: string | null;
  dependenciesInstalled: boolean | null;
}> {
  if (!isLocalMode(config)) {
    throw new Error("Sandbox operations are only supported in local mode");
  }

  logger.info("Resolving sandbox for local run", {
    sandboxSessionId,
    targetRepository,
  });

  if (sandboxSessionId) {
    const existing = getSandbox(sandboxSessionId);
    if (existing) {
      logger.info("Reusing existing sandbox", {
        sandboxId: sandboxSessionId,
      });
      return {
        sandbox: existing,
        codebaseTree: null,
        dependenciesInstalled: null,
      };
    }
  }

  const repoPath = getLocalWorkingDirectory();
  const workspacePath = getWorkspacePathFromConfig(config);
  const sandbox = await createDockerSandbox(SANDBOX_DOCKER_IMAGE, {
    hostRepoPath: repoPath,
    workspacePath,
    repoName: targetRepository.repo,
    commitOnChange: true,
  });

  logger.info("Created sandbox for local run", {
    sandboxId: sandbox.id,
    repoPath,
    workspacePath,
  });

  return { sandbox, codebaseTree: null, dependenciesInstalled: null };
}

const execFile = promisify(execFileCallback);
