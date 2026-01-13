import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { createShellExecutor, isShellAvailable, findAvailableShell, resetShellCache } from "../../utils/shell-executor/index.js";
import { getSandboxMetadata, getPortMappingsFromDocker } from "../../utils/sandbox.js";
import {
  detectDevServer,
  isServerStarted,
  parsePortFromOutput,
} from "../../utils/dev-server.js";
import { getLocalWorkingDirectory, isLocalModeFromEnv } from "@openswe/shared/open-swe/local-mode";

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

// Headers to forward from the client request
const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "x-requested-with",
  "cache-control",
];

// Headers to forward from the upstream response
// Note: content-length is intentionally excluded because we may modify the response body
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "set-cookie",
  "location",
];

/**
 * Handle proxy requests to the dev server.
 * This function fetches content from localhost on the server side,
 * allowing clients to access the dev server through the backend.
 */
async function handleProxyRequest(
  ctx: import("hono").Context,
  path: string,
): Promise<Response> {
  const portStr = ctx.req.param("port");
  const port = parseInt(portStr, 10);
  const sandboxSessionId = ctx.req.query("sandboxSessionId");

  if (isNaN(port) || port < 1 || port > 65535) {
    return ctx.json({ error: "Invalid port number" }, 400);
  }

  // Determine the actual target port
  // If we have a sandboxSessionId, look up the host port from port mappings
  // The port parameter represents the container port, we need to find the host port
  let targetPort = port;

  if (sandboxSessionId) {
    // First try in-memory metadata
    let portMappings = getSandboxMetadata(sandboxSessionId)?.portMappings;

    // If not found in memory, try querying Docker directly
    // This handles cases where the backend restarted but the container is still running
    if (!portMappings) {
      logger.info("Sandbox metadata not in memory, querying Docker", { sandboxSessionId });
      portMappings = await getPortMappingsFromDocker(sandboxSessionId);
    }

    if (portMappings) {
      const mapping = portMappings.find((m) => m.containerPort === port);
      if (mapping) {
        targetPort = mapping.hostPort;
        logger.info("Using port mapping for proxy", {
          sandboxSessionId,
          containerPort: port,
          hostPort: targetPort,
        });
      } else {
        logger.warn("No port mapping found for container port", {
          sandboxSessionId,
          containerPort: port,
          availableMappings: portMappings.map((m) => `${m.containerPort}->${m.hostPort}`),
        });
      }
    } else {
      logger.warn("No port mappings found for sandbox", { sandboxSessionId });
    }
  } else if (isLocalModeFromEnv()) {
    // In local mode without sandboxSessionId, use port as-is (direct localhost access)
    targetPort = port;
  }

  // Construct the target URL
  const targetUrl = new URL(`http://localhost:${targetPort}/${path}`);

  // Copy query parameters
  const url = new URL(ctx.req.url);
  url.searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value);
  });

  try {
    // Build headers to forward
    const headers: Record<string, string> = {};
    FORWARD_REQUEST_HEADERS.forEach((header) => {
      const value = ctx.req.header(header);
      if (value) {
        headers[header] = value;
      }
    });

    // Add custom header to identify proxy requests
    headers["x-openswe-preview-proxy"] = "true";

    // Prepare request body for methods that support it
    let body: string | undefined;
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
      try {
        body = await ctx.req.text();
      } catch {
        // No body or failed to read
      }
    }

    // Make the proxied request
    const response = await fetch(targetUrl.toString(), {
      method: ctx.req.method,
      headers,
      body,
      redirect: "manual", // Handle redirects ourselves
    });

    // Build response headers
    const responseHeaders = new Headers();
    FORWARD_RESPONSE_HEADERS.forEach((header) => {
      const value = response.headers.get(header);
      if (value) {
        // Handle location header for redirects - rewrite to go through proxy
        if (header === "location") {
          try {
            const locationUrl = new URL(value, targetUrl);
            if (
              locationUrl.hostname === "localhost" &&
              locationUrl.port === String(port)
            ) {
              // Rewrite to proxy URL
              const proxyPath = `/dev-server/proxy/${port}${locationUrl.pathname}${locationUrl.search}`;
              responseHeaders.set(header, proxyPath);
              return;
            }
          } catch {
            // Not a valid URL, forward as-is
          }
        }
        responseHeaders.set(header, value);
      }
    });

    // Add CORS headers to allow iframe access
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
    );
    responseHeaders.set(
      "Access-Control-Allow-Headers",
      FORWARD_REQUEST_HEADERS.join(", "),
    );

    // Remove X-Frame-Options if present (allows embedding in iframe)
    responseHeaders.delete("x-frame-options");

    // Handle different response types
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      // For HTML responses, rewrite URLs to go through proxy
      let html = await response.text();

      // Inject a <base> tag to ensure all relative URLs resolve through the proxy
      // This is critical for assets, scripts, stylesheets, etc.
      const baseTag = `<base href="/dev-server/proxy/${port}/">`;

      // Get sandboxSessionId from query params for port mapping
      const url = new URL(ctx.req.url);
      const sandboxSessionId = url.searchParams.get("sandboxSessionId") || "";
      const sandboxParam = sandboxSessionId ? `?sandboxSessionId=${encodeURIComponent(sandboxSessionId)}` : "";

      // Inject a script that intercepts dynamic resource loading
      // This catches JavaScript-initiated requests that bypass HTML rewriting
      const interceptScript = `<script>
(function() {
  var proxyBase = '/dev-server/proxy/${port}';
  var sandboxParam = '${sandboxParam}';

  function addSandboxParam(url) {
    if (!sandboxParam) return url;
    var separator = url.includes('?') ? '&' : '?';
    return url + separator + sandboxParam.substring(1);
  }

  // Intercept dynamic script/link/img creation
  var origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = origCreateElement(tag);
    var tagLower = tag.toLowerCase();
    if (tagLower === 'script' || tagLower === 'link' || tagLower === 'img') {
      var origSetAttribute = el.setAttribute.bind(el);
      el.setAttribute = function(name, value) {
        if ((name === 'src' || name === 'href') && typeof value === 'string' && value.startsWith('/') && !value.startsWith(proxyBase)) {
          value = addSandboxParam(proxyBase + value);
        }
        return origSetAttribute(name, value);
      };
      // Also intercept direct property assignment
      var descriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src') ||
                       Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src') ||
                       Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
      if (descriptor && descriptor.set) {
        var origSetter = descriptor.set;
        Object.defineProperty(el, tagLower === 'link' ? 'href' : 'src', {
          set: function(value) {
            if (typeof value === 'string' && value.startsWith('/') && !value.startsWith(proxyBase)) {
              value = addSandboxParam(proxyBase + value);
            }
            origSetter.call(this, value);
          },
          get: descriptor.get
        });
      }
    }
    return el;
  };

  // Intercept fetch requests
  var origFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(proxyBase)) {
      url = addSandboxParam(proxyBase + url);
    }
    return origFetch.call(this, url, options);
  };

  // Intercept XHR
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(proxyBase)) {
      url = addSandboxParam(proxyBase + url);
    }
    return origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
})();
</script>`;

      // Insert base tag and intercept script right after <head> if present
      const headInsert = baseTag + interceptScript;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${headInsert}`);
      } else if (html.includes("<head ")) {
        html = html.replace(/<head([^>]*)>/, `<head$1>${headInsert}`);
      } else if (html.includes("<HEAD>")) {
        html = html.replace("<HEAD>", `<HEAD>${headInsert}`);
      } else if (html.includes("<html")) {
        html = html.replace(/<html([^>]*)>/, `<html$1><head>${headInsert}</head>`);
      } else {
        html = `<head>${headInsert}</head>${html}`;
      }

      // Rewrite ALL absolute paths starting with / to go through proxy
      // Simple approach: replace common patterns that indicate absolute URLs
      // This catches "/_next/", "/_app/", "/static/", etc.
      html = html.replace(/"\/(?!dev-server\/proxy|api\/preview|http)/g, `"/dev-server/proxy/${port}/`);
      html = html.replace(/'\/(?!dev-server\/proxy|api\/preview|http)/g, `'/dev-server/proxy/${port}/`);

      // Also rewrite http://localhost URLs
      html = html.replace(
        new RegExp(`http://localhost:${port}/`, "gi"),
        `/dev-server/proxy/${port}/`,
      );

      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // For other content types, stream the response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    // Connection refused or other network error
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("ECONNREFUSED")) {
      return ctx.json(
        {
          error: "Connection refused",
          message: `No server running on port ${port}. Start your development server first.`,
        },
        503,
      );
    }

    return ctx.json(
      {
        error: "Proxy error",
        message: errorMessage,
      },
      502,
    );
  }
}

export function registerDevServerRoute(app: Hono) {
  /**
   * POST /dev-server/start
   * Starts a dev server manually with a specified command.
   */
  app.post("/dev-server/start", async (ctx) => {
    const requestStartedAt = Date.now();

    // Reset shell cache to ensure fresh detection
    resetShellCache();

    const shellAvailable = isShellAvailable();
    const availableShell = findAvailableShell();

    logger.info("Received dev server start request", {
      localMode: isLocalModeFromEnv(),
      shellAvailable,
      availableShell,
    });

    // Check shell availability early for local mode
    if (isLocalModeFromEnv() && !shellAvailable) {
      logger.error("No shell available for local mode", {
        availableShell,
        checkedPaths: ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/usr/local/bin/bash", "/usr/local/bin/sh"],
      });
      return ctx.json<StartDevServerResponse>(
        {
          success: false,
          message: "No shell available to execute commands",
          error: `No working shell found. The backend environment may not have bash or sh installed. Checked: /bin/bash, /usr/bin/bash, /bin/sh, /usr/bin/sh, /usr/local/bin/bash, /usr/local/bin/sh`,
        },
        500 as ContentfulStatusCode,
      );
    }

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

    logger.info("Processing dev server start", {
      sandboxSessionId,
      command,
      port,
      workdir,
    });

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
      logger.info("Executing background command", {
        command: backgroundCommand,
        workdir: effectiveWorkdir,
        shell: findAvailableShell(),
      });

      const startResult = await executor.executeCommand({
        command: backgroundCommand,
        workdir: effectiveWorkdir,
        timeout: 10,
        sandboxSessionId,
      });

      if (startResult.exitCode !== 0) {
        logger.error("Failed to start dev server", {
          exitCode: startResult.exitCode,
          stdout: startResult.artifacts?.stdout,
          stderr: startResult.artifacts?.stderr,
          result: startResult.result,
        });
        return ctx.json<StartDevServerResponse>(
          {
            success: false,
            message: "Failed to start dev server",
            error: startResult.result || startResult.artifacts?.stderr || `Exit code: ${startResult.exitCode}`,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error("Error starting dev server", {
        error: errorMessage,
        stack: errorStack,
        durationMs: Date.now() - requestStartedAt,
        localMode: isLocalModeFromEnv(),
        shell: findAvailableShell(),
        workdir: effectiveWorkdir,
      });

      // Provide helpful error message for common issues
      let helpfulMessage = errorMessage;
      if (errorMessage.includes("ENOENT")) {
        helpfulMessage = `Command not found or shell unavailable. Shell: ${findAvailableShell() || "none"}. Original error: ${errorMessage}`;
      } else if (errorMessage.includes("EACCES")) {
        helpfulMessage = `Permission denied. Check that the working directory exists and is accessible. Original error: ${errorMessage}`;
      }

      return ctx.json<StartDevServerResponse>(
        {
          success: false,
          message: "Error starting dev server",
          error: helpfulMessage,
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
   * ALL /dev-server/proxy/:port/*
   * Proxies requests to the dev server running on the specified port.
   * This allows the frontend to access the dev server through the backend,
   * bypassing client-side firewall/network restrictions.
   */
  app.all("/dev-server/proxy/:port", async (ctx) => {
    return handleProxyRequest(ctx, "");
  });

  app.all("/dev-server/proxy/:port/*", async (ctx) => {
    const path = ctx.req.param("*") || "";
    return handleProxyRequest(ctx, path);
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
