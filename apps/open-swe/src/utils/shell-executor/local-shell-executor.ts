import { spawn, spawnSync } from "child_process";
import { accessSync, constants } from "fs";
import { LocalExecuteResponse } from "./types.js";
import { createLogger, LogLevel } from "../logger.js";
import { TIMEOUT_SEC } from "@openswe/shared/constants";

const TIMEOUT_EXIT_CODE = 124;
const SHELL_NOT_AVAILABLE_EXIT_CODE = 127;

/**
 * Maximum output size to prevent memory issues and JSON serialization failures.
 * When exceeded, we keep the start and end of the output.
 */
const MAX_OUTPUT_SIZE = 500_000; // 500KB per stream (stdout/stderr)
const TRUNCATION_BUFFER = 200_000; // Keep 200KB from start and end

const logger = createLogger(LogLevel.INFO, "LocalShellExecutor");

/**
 * Truncate output to prevent memory issues while preserving useful context.
 * Keeps the beginning and end of the output when it exceeds the limit.
 */
function truncateStreamOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return output;
  }

  const truncationMarker = `\n\n... [${output.length - TRUNCATION_BUFFER * 2} characters truncated to prevent memory issues] ...\n\n`;
  return output.slice(0, TRUNCATION_BUFFER) + truncationMarker + output.slice(-TRUNCATION_BUFFER);
}

// Candidate shell paths in order of preference
const SHELL_PATHS = [
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/sh",
  "/usr/bin/sh",
  // Also try common locations on different systems
  "/usr/local/bin/bash",
  "/usr/local/bin/sh",
];

// Cached available shell path - checked once and reused
let cachedAvailableShell: string | null | undefined = undefined;

/**
 * Test if a shell actually works by trying to run a simple command.
 * This is more reliable than just checking if the file exists.
 */
function testShell(shellPath: string): boolean {
  try {
    const result = spawnSync(shellPath, ["-c", "echo test"], {
      timeout: 5000,
      encoding: "utf-8",
    });
    return result.status === 0 && result.stdout?.includes("test");
  } catch (error) {
    logger.debug("Shell test failed", { shellPath, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Check if a shell executable exists and is executable.
 * Caches the result for subsequent calls.
 * @returns The path to an available shell, or null if none found
 */
export function findAvailableShell(): string | null {
  // Return cached result if already checked
  if (cachedAvailableShell !== undefined) {
    return cachedAvailableShell;
  }

  for (const shellPath of SHELL_PATHS) {
    try {
      // First check if file exists and is executable
      accessSync(shellPath, constants.X_OK);

      // Then actually test the shell works
      if (testShell(shellPath)) {
        cachedAvailableShell = shellPath;
        logger.info("Found available shell", { shellPath });
        return shellPath;
      } else {
        logger.debug("Shell exists but test failed", { shellPath });
      }
    } catch {
      // Shell not available at this path, try next
      continue;
    }
  }

  cachedAvailableShell = null;
  logger.error("No shell available", {
    checkedPaths: SHELL_PATHS,
  });
  return null;
}

/**
 * Check if any shell is available for command execution.
 * This is a fast synchronous check that can be used before attempting to run commands.
 */
export function isShellAvailable(): boolean {
  return findAvailableShell() !== null;
}

/**
 * Reset the cached shell path. Useful for testing or if shell availability may have changed.
 */
export function resetShellCache(): void {
  cachedAvailableShell = undefined;
}

export class LocalShellExecutor {
  private workingDirectory: string;
  private availableShell: string | null;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;

    // Pre-check shell availability at construction time
    this.availableShell = findAvailableShell();

    if (this.availableShell) {
      logger.info("LocalShellExecutor created", {
        workingDirectory,
        shell: this.availableShell,
      });
    } else {
      logger.warn("LocalShellExecutor created but no shell available", {
        workingDirectory,
        checkedPaths: SHELL_PATHS,
      });
    }
  }

  async executeCommand(
    command: string,
    args?: {
      workdir?: string;
      env?: Record<string, string>;
      timeout?: number;
      localMode?: boolean;
    },
  ): Promise<LocalExecuteResponse> {
    const { workdir, env, timeout = TIMEOUT_SEC, localMode = false } = args || {};
    const cwd = workdir || this.workingDirectory;
    const environment = { ...process.env, ...(env || {}) };

    // Fail fast if no shell is available - don't wait for spawn to fail
    if (!this.availableShell) {
      const errorMessage = `No shell available to execute command. Checked paths: ${SHELL_PATHS.join(", ")}`;
      logger.error("Cannot execute command - no shell available", {
        command,
        cwd,
        checkedPaths: SHELL_PATHS,
      });
      return {
        exitCode: SHELL_NOT_AVAILABLE_EXIT_CODE,
        result: errorMessage,
        artifacts: {
          stdout: "",
          stderr: errorMessage,
        },
      };
    }

    logger.info("Executing command locally", {
      command,
      cwd,
      localMode,
      shell: this.availableShell,
    });

    // In local mode, use spawn directly for better reliability
    if (localMode) {
      try {
        const cleanEnv = Object.fromEntries(
          Object.entries(environment).filter(([_, v]) => v !== undefined),
        ) as Record<string, string>;
        const result = await this.executeWithSpawn(
          command,
          cwd,
          cleanEnv,
          timeout,
        );
        return result;
      } catch (spawnError: any) {
        logger.error("Spawn execution failed in local mode", {
          command,
          error: spawnError.message,
        });

        return {
          exitCode: 1,
          result: spawnError.message,
          artifacts: {
            stdout: "",
            stderr: spawnError.message,
          },
        };
      }
    }

    // Non-local mode: throw error as this executor is for local mode only
    throw new Error("LocalShellExecutor is only for local mode operations");
  }

  private async executeWithSpawn(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeout: number,
  ): Promise<LocalExecuteResponse> {
    // Use the pre-checked available shell (already validated in executeCommand)
    const shellPath = this.availableShell!;

    return new Promise((resolve, reject) => {
      const child = spawn(shellPath, ["-c", command], {
        cwd,
        env: { ...process.env, ...env },
      });

      let stdout = "";
      let stderr = "";
      let completed = false;
      let timedOut = false;
      const timeoutMs = timeout > 0 ? timeout * 1000 : undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const timeoutMessage = `Command timed out after ${timeout} seconds`;

      if (timeoutMs) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          stderr = stderr.length > 0 ? `${stderr}\n${timeoutMessage}` : timeoutMessage;
          if (!child.killed) {
            try {
              child.kill("SIGKILL");
            } catch (killError) {
              logger.warn("Failed to terminate timed out local command", {
                command,
                error: killError instanceof Error ? killError.message : String(killError),
              });
            }
          }
        }, timeoutMs);
      }

      const finish = (result: LocalExecuteResponse) => {
        if (completed) {
          return;
        }
        completed = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve(result);
      };

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        // Truncate outputs to prevent memory issues and JSON serialization failures
        const truncatedStdout = truncateStreamOutput(stdout);
        const truncatedStderr = truncateStreamOutput(stderr);

        if (timedOut) {
          logger.warn("Local command exceeded timeout", {
            command,
            timeoutSeconds: timeout,
          });
          finish({
            exitCode: TIMEOUT_EXIT_CODE,
            result: timeoutMessage,
            artifacts: {
              stdout: truncatedStdout,
              stderr: truncatedStderr,
            },
          });
          return;
        }

        finish({
          exitCode: code ?? 0,
          result: truncatedStdout,
          artifacts: {
            stdout: truncatedStdout,
            stderr: truncatedStderr,
          },
        });
      });

      child.on("error", (error) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        if (timedOut) {
          finish({
            exitCode: TIMEOUT_EXIT_CODE,
            result: timeoutMessage,
            artifacts: {
              stdout: truncateStreamOutput(stdout),
              stderr: truncateStreamOutput(stderr),
            },
          });
          return;
        }

        // Shell error - this shouldn't happen since we pre-checked availability
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger.error("Shell spawn error (unexpected - shell was pre-checked)", {
          command,
          shell: shellPath,
          error: errorObj.message,
        });
        reject(errorObj);
      });
    });
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  setWorkingDirectory(directory: string): void {
    this.workingDirectory = directory;
    logger.info("Working directory changed", { workingDirectory: directory });
  }

  /**
   * Get the shell path being used by this executor.
   * @returns The available shell path, or null if no shell is available
   */
  getAvailableShell(): string | null {
    return this.availableShell;
  }

  /**
   * Check if this executor has a shell available for command execution.
   */
  hasShellAvailable(): boolean {
    return this.availableShell !== null;
  }
}

let sharedExecutor: LocalShellExecutor | null = null;

export function getLocalShellExecutor(
  workingDirectory?: string,
): LocalShellExecutor {
  if (
    !sharedExecutor ||
    (workingDirectory &&
      sharedExecutor.getWorkingDirectory() !== workingDirectory)
  ) {
    sharedExecutor = new LocalShellExecutor(workingDirectory);
  }
  return sharedExecutor;
}
