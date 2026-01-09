import { v4 as uuidv4 } from "uuid";
import { AIMessage } from "@langchain/core/messages";
import {
  GraphConfig,
  GraphState,
  GraphUpdate,
} from "@openswe/shared/open-swe/types";
import { createShellExecutor } from "../../../utils/shell-executor/index.js";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import {
  detectDevServer,
  DevServerConfig,
  isServerStarted,
  parsePortFromOutput,
} from "../../../utils/dev-server.js";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import { getSandboxMetadata } from "../../../utils/sandbox.js";

const logger = createLogger(LogLevel.INFO, "StartDevServer");

// How long to wait for the dev server to start (in ms)
const SERVER_STARTUP_TIMEOUT_MS = 15000;
// How long to wait between checks (in ms)
const CHECK_INTERVAL_MS = 1000;

/**
 * Attempts to start the dev server after the programmer completes.
 * This node detects the project type and runs the appropriate dev command.
 */
export async function startDevServer(
  state: GraphState,
  config: GraphConfig,
): Promise<GraphUpdate> {
  logger.info("Checking if dev server should be started", {
    sandboxSessionId: state.sandboxSessionId,
    previewPort: state.previewPort,
  });

  // Check if we have a codebase tree to analyze
  if (!state.codebaseTree) {
    logger.info("No codebase tree available, skipping dev server start");
    return createSkipResponse(state, "No codebase information available.");
  }

  // Try to read package.json content for better detection
  let packageJsonContent: string | undefined;
  try {
    const executor = createShellExecutor(config);
    const workdir = getWorkdir(state, config);

    const result = await executor.executeCommand({
      command: "cat package.json",
      workdir,
      timeout: 10,
      sandboxSessionId: state.sandboxSessionId,
    });

    if (result.exitCode === 0) {
      packageJsonContent = result.result || result.artifacts?.stdout;
    }
  } catch (error) {
    logger.debug("Could not read package.json", { error });
  }

  // Detect dev server configuration
  const devConfig = detectDevServer(state.codebaseTree, packageJsonContent);

  if (!devConfig || !devConfig.isWebProject) {
    logger.info("No web project detected, skipping dev server start");
    return createSkipResponse(
      state,
      "This doesn't appear to be a web project that needs a dev server.",
    );
  }

  logger.info("Detected web project, starting dev server", {
    projectType: devConfig.projectType,
    command: devConfig.command,
    port: devConfig.port,
  });

  // Start the dev server
  try {
    const result = await startServer(state, config, devConfig);
    return result;
  } catch (error) {
    logger.error("Failed to start dev server", { error });
    return createErrorResponse(
      state,
      `Failed to start dev server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Get the working directory for the current mode.
 */
function getWorkdir(state: GraphState, config: GraphConfig): string {
  if (isLocalMode(config)) {
    return getLocalWorkingDirectory();
  }
  // For sandbox mode, use the container repo path from metadata
  const metadata = getSandboxMetadata(state.sandboxSessionId ?? "");
  return metadata?.containerRepoPath ?? "/workspace/src";
}

/**
 * Start the dev server and wait for it to be ready.
 */
async function startServer(
  state: GraphState,
  config: GraphConfig,
  devConfig: DevServerConfig,
): Promise<GraphUpdate> {
  const executor = createShellExecutor(config);
  const workdir = getWorkdir(state, config);
  const port = state.previewPort || devConfig.port;

  // First, check if dependencies are installed
  if (!state.dependenciesInstalled && devConfig.projectType !== "go") {
    logger.info("Dependencies may not be installed, attempting to install first");

    // Determine install command based on project type
    let installCommand = "npm install";
    if (devConfig.projectType === "django" || devConfig.projectType === "flask" || devConfig.projectType === "fastapi") {
      installCommand = "pip install -r requirements.txt 2>/dev/null || pip install -e . 2>/dev/null || true";
    } else if (devConfig.projectType === "rails") {
      installCommand = "bundle install";
    }

    try {
      const installResult = await executor.executeCommand({
        command: installCommand,
        workdir,
        timeout: 300, // 5 minutes for install
        sandboxSessionId: state.sandboxSessionId,
      });

      if (installResult.exitCode !== 0) {
        logger.warn("Dependency installation may have failed", {
          exitCode: installResult.exitCode,
        });
      }
    } catch (error) {
      logger.warn("Failed to install dependencies", { error });
    }
  }

  // Build the command to run in the background
  // We use nohup to prevent the process from being killed when the shell exits
  // and redirect output to a log file we can check
  const logFile = "/tmp/dev-server.log";
  const pidFile = "/tmp/dev-server.pid";

  // Modify command to use the configured port
  let serverCommand = devConfig.command;
  if (devConfig.projectType === "nextjs" || devConfig.projectType === "vite" || devConfig.projectType === "vue") {
    serverCommand = `PORT=${port} ${devConfig.command}`;
  } else if (devConfig.projectType === "django") {
    serverCommand = `python manage.py runserver 0.0.0.0:${port}`;
  } else if (devConfig.projectType === "flask") {
    serverCommand = `FLASK_RUN_PORT=${port} flask run --host=0.0.0.0`;
  } else if (devConfig.projectType === "fastapi") {
    serverCommand = `uvicorn main:app --reload --host 0.0.0.0 --port ${port}`;
  }

  // Start the server in the background
  const backgroundCommand = `nohup ${serverCommand} > ${logFile} 2>&1 & echo $! > ${pidFile}`;

  logger.info("Starting dev server in background", {
    command: serverCommand,
    port,
    workdir,
  });

  const startResult = await executor.executeCommand({
    command: backgroundCommand,
    workdir,
    timeout: 10,
    sandboxSessionId: state.sandboxSessionId,
  });

  if (startResult.exitCode !== 0) {
    return createErrorResponse(
      state,
      `Failed to start dev server: ${startResult.result || startResult.artifacts?.stderr}`,
    );
  }

  // Wait for the server to start
  const serverReady = await waitForServer(executor, workdir, logFile, port, state.sandboxSessionId);

  if (serverReady.ready) {
    const actualPort = serverReady.port || port;
    logger.info("Dev server started successfully", {
      port: actualPort,
      projectType: devConfig.projectType,
    });

    const message = new AIMessage({
      id: uuidv4(),
      content: `Dev server started successfully on port ${actualPort}. You can view the app in the Preview tab.`,
    });

    return {
      messages: [message],
      internalMessages: [message],
      taskPlan: state.taskPlan,
      previewPort: actualPort,
    };
  } else {
    // Server didn't start in time, but it might still be starting
    // Return a warning but still set the port
    logger.warn("Dev server may not have started correctly", {
      output: serverReady.output,
    });

    const message = new AIMessage({
      id: uuidv4(),
      content: `Dev server was started but may not be ready yet. Check the Preview tab on port ${port}. If it doesn't load, the server may still be starting or there may be an error in the server logs.`,
    });

    return {
      messages: [message],
      internalMessages: [message],
      taskPlan: state.taskPlan,
      previewPort: port,
    };
  }
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
    // Check the log file
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
      if (output.includes("Error:") || output.includes("EADDRINUSE") || output.includes("error")) {
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

/**
 * Create a response for when we skip starting the dev server.
 */
function createSkipResponse(state: GraphState, reason: string): GraphUpdate {
  const message = new AIMessage({
    id: uuidv4(),
    content: reason,
  });

  return {
    messages: [message],
    internalMessages: [message],
    taskPlan: state.taskPlan,
  };
}

/**
 * Create an error response.
 */
function createErrorResponse(state: GraphState, error: string): GraphUpdate {
  const message = new AIMessage({
    id: uuidv4(),
    content: `Dev server error: ${error}`,
  });

  return {
    messages: [message],
    internalMessages: [message],
    taskPlan: state.taskPlan,
  };
}
