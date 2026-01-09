import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { createShellExecutor } from "../../utils/shell-executor/index.js";
import { getSandboxMetadata } from "../../utils/sandbox.js";
import {
  detectDevServer,
  isServerStarted,
  parsePortFromOutput,
} from "../../utils/dev-server.js";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";

const logger = createLogger(LogLevel.INFO, "DevServerRoute");

// How long to wait for the dev server to start (in ms)
const SERVER_STARTUP_TIMEOUT_MS = 15000;
// How long to wait between checks (in ms)
const CHECK_INTERVAL_MS = 1000;

interface StartDevServerRequest {
  sandboxSessionId?: string;
  command?: string;
  port?: number;
  workdir?: string;
}

interface StartDevServerResponse {
  success: boolean;
  port?: number;
  message: string;
  error?: string;
}

/**
 * Wait for the dev server to be ready by checking its log output.
 */
async function waitForServer(
  executor: ReturnType<typeof createShellExecutor>,
  workdir: string,
  logFile: string,
  expectedPort: number,
  sandboxSessionId?: string,
): Promise<{ ready: boolean; port?: number; output?: string }> {
  const startTime = Date.now();

  while (Date.now() - startTime < SERVER_STARTUP_TIMEOUT_MS) {
    try {
      const logResult = await executor.executeCommand({
        command: `cat ${logFile} 2>/dev/null || echo ""`,
        workdir,
        timeout: 5,
        sandboxSessionId,
      });

      const output = logResult.result || logResult.artifacts?.stdout || "";

      // Check if server has started
      if (isServerStarted(output)) {
        const detectedPort = parsePortFromOutput(output);
        return {
          ready: true,
          port: detectedPort || expectedPort,
          output,
        };
      }

      // Check for error patterns
      if (
        output.includes("Error:") ||
        output.includes("EADDRINUSE") ||
        output.includes("error")
      ) {
        // If there's an error but also a port, the server might still be running
        const detectedPort = parsePortFromOutput(output);
        if (detectedPort) {
          return {
            ready: true,
            port: detectedPort,
            output,
          };
        }
      }
    } catch (error) {
      logger.debug("Error checking server status", { error });
    }

    // Wait before next check
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  // Timeout - try one last time to get the output
  try {
    const logResult = await executor.executeCommand({
      command: `cat ${logFile} 2>/dev/null || echo ""`,
      workdir,
      timeout: 5,
      sandboxSessionId,
    });
    return {
      ready: false,
      output: logResult.result || logResult.artifacts?.stdout,
    };
  } catch {
    return { ready: false };
  }
}

export function registerDevServerRoute(app: Hono) {
  /**
   * POST /dev-server/start
   * Starts a dev server manually with a specified command.
   */
  app.post("/dev-server/start", async (ctx) => {
    const requestStartedAt = Date.now();
    logger.info("Received dev server start request");

    let body: StartDevServerRequest;
    try {
      body = await ctx.req.json<StartDevServerRequest>();
    } catch (error) {
      logger.error("Invalid JSON payload", {
        error: error instanceof Error ? error.message : String(error),
      });
      return ctx.json<StartDevServerResponse>(
        {
          success: false,
          message: "Invalid JSON payload",
          error: error instanceof Error ? error.message : String(error),
        },
        400 as ContentfulStatusCode,
      );
    }

    const { sandboxSessionId, command, port = 3000, workdir } = body;

    // Determine working directory
    let effectiveWorkdir = workdir;
    if (!effectiveWorkdir) {
      if (sandboxSessionId) {
        const metadata = getSandboxMetadata(sandboxSessionId);
        effectiveWorkdir = metadata?.containerRepoPath ?? "/workspace/src";
      } else {
        effectiveWorkdir = getLocalWorkingDirectory();
      }
    }

    // Determine command to run
    let serverCommand = command;
    if (!serverCommand) {
      // Try to auto-detect based on package.json
      const executor = createShellExecutor();
      try {
        const result = await executor.executeCommand({
          command: "cat package.json",
          workdir: effectiveWorkdir,
          timeout: 10,
          sandboxSessionId,
        });

        if (result.exitCode === 0) {
          const packageJsonContent = result.result || result.artifacts?.stdout;
          const devConfig = detectDevServer("", packageJsonContent);
          if (devConfig) {
            serverCommand = devConfig.command;
          }
        }
      } catch {
        // Ignore errors, will fall back to default
      }

      // Fall back to npm run dev if no command detected
      if (!serverCommand) {
        serverCommand = "npm run dev";
      }
    }

    logger.info("Starting dev server", {
      command: serverCommand,
      port,
      workdir: effectiveWorkdir,
      sandboxSessionId,
    });

    const executor = createShellExecutor();
    const logFile = "/tmp/dev-server.log";
    const pidFile = "/tmp/dev-server.pid";

    // Kill any existing dev server first
    try {
      await executor.executeCommand({
        command: `if [ -f ${pidFile} ]; then kill $(cat ${pidFile}) 2>/dev/null || true; rm -f ${pidFile}; fi`,
        workdir: effectiveWorkdir,
        timeout: 5,
        sandboxSessionId,
      });
    } catch {
      // Ignore errors when stopping existing server
    }

    // Modify command to use the configured port
    let portedCommand = serverCommand;
    if (serverCommand.includes("npm run dev") || serverCommand.includes("yarn dev") || serverCommand.includes("pnpm dev")) {
      portedCommand = `PORT=${port} ${serverCommand}`;
    } else if (serverCommand.includes("vite")) {
      portedCommand = `${serverCommand} --port ${port}`;
    } else if (serverCommand.includes("next")) {
      portedCommand = `PORT=${port} ${serverCommand}`;
    }

    // Start the server in the background
    const backgroundCommand = `nohup ${portedCommand} > ${logFile} 2>&1 & echo $! > ${pidFile}`;

    try {
      const startResult = await executor.executeCommand({
        command: backgroundCommand,
        workdir: effectiveWorkdir,
        timeout: 10,
        sandboxSessionId,
      });

      if (startResult.exitCode !== 0) {
        logger.error("Failed to start dev server", {
          exitCode: startResult.exitCode,
          output: startResult.result || startResult.artifacts?.stderr,
        });
        return ctx.json<StartDevServerResponse>(
          {
            success: false,
            message: "Failed to start dev server",
            error: startResult.result || startResult.artifacts?.stderr,
          },
          500 as ContentfulStatusCode,
        );
      }

      // Wait for the server to start
      const serverReady = await waitForServer(
        executor,
        effectiveWorkdir,
        logFile,
        port,
        sandboxSessionId,
      );

      if (serverReady.ready) {
        const actualPort = serverReady.port || port;
        logger.info("Dev server started successfully", {
          port: actualPort,
          durationMs: Date.now() - requestStartedAt,
        });

        return ctx.json<StartDevServerResponse>({
          success: true,
          port: actualPort,
          message: `Dev server started on port ${actualPort}`,
        });
      } else {
        // Server didn't start in time, but it might still be starting
        logger.warn("Dev server may not have started correctly", {
          output: serverReady.output,
          durationMs: Date.now() - requestStartedAt,
        });

        return ctx.json<StartDevServerResponse>({
          success: true,
          port,
          message: `Dev server was started but may not be ready yet. Check port ${port}.`,
        });
      }
    } catch (error) {
      logger.error("Error starting dev server", {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - requestStartedAt,
      });
      return ctx.json<StartDevServerResponse>(
        {
          success: false,
          message: "Error starting dev server",
          error: error instanceof Error ? error.message : String(error),
        },
        500 as ContentfulStatusCode,
      );
    }
  });

  /**
   * POST /dev-server/stop
   * Stops the running dev server.
   */
  app.post("/dev-server/stop", async (ctx) => {
    logger.info("Received dev server stop request");

    let body: { sandboxSessionId?: string; workdir?: string };
    try {
      body = await ctx.req.json();
    } catch {
      body = {};
    }

    const { sandboxSessionId, workdir } = body;

    let effectiveWorkdir = workdir;
    if (!effectiveWorkdir) {
      if (sandboxSessionId) {
        const metadata = getSandboxMetadata(sandboxSessionId);
        effectiveWorkdir = metadata?.containerRepoPath ?? "/workspace/src";
      } else {
        effectiveWorkdir = getLocalWorkingDirectory();
      }
    }

    const executor = createShellExecutor();
    const pidFile = "/tmp/dev-server.pid";

    try {
      await executor.executeCommand({
        command: `if [ -f ${pidFile} ]; then kill $(cat ${pidFile}) 2>/dev/null || true; rm -f ${pidFile}; fi`,
        workdir: effectiveWorkdir,
        timeout: 5,
        sandboxSessionId,
      });

      return ctx.json({
        success: true,
        message: "Dev server stopped",
      });
    } catch (error) {
      return ctx.json(
        {
          success: false,
          message: "Failed to stop dev server",
          error: error instanceof Error ? error.message : String(error),
        },
        500 as ContentfulStatusCode,
      );
    }
  });

  /**
   * GET /dev-server/status
   * Checks if the dev server is running.
   */
  app.get("/dev-server/status", async (ctx) => {
    const sandboxSessionId = ctx.req.query("sandboxSessionId");

    let workdir: string;
    if (sandboxSessionId) {
      const metadata = getSandboxMetadata(sandboxSessionId);
      workdir = metadata?.containerRepoPath ?? "/workspace/src";
    } else {
      workdir = getLocalWorkingDirectory();
    }

    const executor = createShellExecutor();
    const pidFile = "/tmp/dev-server.pid";
    const logFile = "/tmp/dev-server.log";

    try {
      // Check if PID file exists and process is running
      const pidResult = await executor.executeCommand({
        command: `if [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); if ps -p $pid > /dev/null 2>&1; then echo "running:$pid"; else echo "stopped"; fi; else echo "stopped"; fi`,
        workdir,
        timeout: 5,
        sandboxSessionId,
      });

      const output = pidResult.result || pidResult.artifacts?.stdout || "";
      const isRunning = output.startsWith("running:");
      const pid = isRunning ? output.split(":")[1]?.trim() : undefined;

      // Get recent log output if running
      let recentLog: string | undefined;
      if (isRunning) {
        try {
          const logResult = await executor.executeCommand({
            command: `tail -20 ${logFile} 2>/dev/null || echo ""`,
            workdir,
            timeout: 5,
            sandboxSessionId,
          });
          recentLog = logResult.result || logResult.artifacts?.stdout;
        } catch {
          // Ignore log errors
        }
      }

      return ctx.json({
        running: isRunning,
        pid,
        recentLog,
      });
    } catch (error) {
      return ctx.json({
        running: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
