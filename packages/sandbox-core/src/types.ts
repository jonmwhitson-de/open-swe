export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: string;
  artifacts?: {
    stdout: string;
    stderr: string;
  };
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface SandboxResourceLimits {
  cpuCount?: number;
  memoryBytes?: number;
  pidsLimit?: number;
}

export interface SandboxMetadata {
  containerId?: string;
  containerName?: string;
  requestedResources?: SandboxResourceLimits;
  appliedResources?: SandboxResourceLimits;
  /**
   * Ports that are exposed from the container for preview functionality.
   * The first port in this array is typically the primary preview port.
   */
  exposedPorts?: number[];
}

export interface SandboxHandle {
  id: string;
  metadata?: SandboxMetadata;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSec?: number,
    ): Promise<ExecResult>;
  };
}

export interface SandboxProvider {
  createSandbox(image: string, mountPath?: string): Promise<SandboxHandle>;
  getSandbox(id: string): SandboxHandle | undefined;
  stopSandbox(id: string): Promise<string>;
  deleteSandbox(id: string): Promise<boolean>;
  exec(
    target: SandboxHandle | string,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<ExecResult>;
}
