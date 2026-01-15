import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
import { spawn } from "child_process";
import { createServer } from "net";
import path from "path";

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Start the server locally (for local mode)
 */
async function startLocalServer(
  command: string,
  workspacePath: string,
  port: number
): Promise<{ success: boolean; message: string; error?: string; port?: number }> {
  return new Promise((resolve) => {
    console.log("[start-server] Starting local server:", { command, workspacePath, port });

    const child = spawn("bash", ["-c", command], {
      cwd: workspacePath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        FLASK_RUN_PORT: String(port),
      },
    });

    child.unref();

    let output = "";
    let errorOutput = "";

    child.stdout?.on("data", (data) => {
      output += data.toString();
      console.log("[start-server] stdout:", data.toString());
    });

    child.stderr?.on("data", (data) => {
      errorOutput += data.toString();
      console.log("[start-server] stderr:", data.toString());
    });

    // Give the server some time to start
    setTimeout(() => {
      resolve({
        success: true,
        message: "Server starting...",
        port,
      });
    }, 2000);

    child.on("error", (err) => {
      console.error("[start-server] Process error:", err);
      resolve({
        success: false,
        message: "Failed to start server",
        error: err.message,
      });
    });
  });
}

/**
 * POST /api/preview/start-server
 * Starts a dev server. In local mode, runs directly; otherwise proxies to backend.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const isLocalMode = process.env.OPEN_SWE_LOCAL_MODE === "true";
  const localReposDir = process.env.OPEN_SWE_LOCAL_REPOS_DIR || "/tmp/open-swe-workspaces";

  const backendUrl =
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024";

  console.log("[start-server] Mode:", isLocalMode ? "local" : "backend");
  console.log("[start-server] Backend URL:", backendUrl);

  let body: { command?: string; port?: number; workspacePath?: string; sandboxSessionId?: string };
  try {
    body = await request.json();
    console.log("[start-server] Request body:", body);
  } catch (error) {
    console.error("[start-server] Failed to parse request body:", error);
    return NextResponse.json(
      {
        success: false,
        message: "Invalid request body",
        error: error instanceof Error ? error.message : "Failed to parse JSON",
      },
      { status: 400 },
    );
  }

  const { command = "./start.sh", port = 5000, workspacePath } = body;

  // Check for port conflict first
  const portAvailable = await isPortAvailable(port);
  if (!portAvailable) {
    console.log("[start-server] Port conflict detected:", port);
    return NextResponse.json({
      success: false,
      message: `Port ${port} is already in use`,
      portConflict: true,
    });
  }

  // In local mode, run the server directly
  if (isLocalMode) {
    // Determine workspace path
    let targetPath = workspacePath;
    if (!targetPath) {
      const { promises: fs } = await import("fs");
      const entries = await fs.readdir(localReposDir).catch(() => []);
      if (entries.length > 0) {
        targetPath = path.join(localReposDir, entries[0]);
      }
    }

    if (!targetPath) {
      return NextResponse.json({
        success: false,
        message: "No workspace path available",
        error: "Could not determine workspace path",
      });
    }

    const result = await startLocalServer(command, targetPath, port);
    return NextResponse.json(result);
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
      headers[LOCAL_MODE_HEADER] = "true";
    }

    console.log("[start-server] Fetching:", `${backendUrl}/dev-server/start`);

    const response = await fetch(`${backendUrl}/dev-server/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    console.log("[start-server] Response status:", response.status);

    // Try to parse response as JSON
    let result: unknown;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      result = await response.json();
      console.log("[start-server] Response JSON:", result);
    } else {
      const text = await response.text();
      console.log("[start-server] Response text:", text.substring(0, 500));
      result = {
        success: false,
        message: "Backend returned non-JSON response",
        error: text.substring(0, 500),
      };
    }

    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start dev server";
    const errorName = error instanceof Error ? error.name : "Unknown";

    console.error("[start-server] Fetch error:", {
      name: errorName,
      message,
      error,
    });

    // Provide more helpful error for connection issues
    let helpfulMessage = message;
    let statusCode = 500;

    if (message.includes("ECONNREFUSED") || message.includes("connect ECONNREFUSED")) {
      helpfulMessage = `Cannot connect to backend at ${backendUrl}. Is the backend server running on port 2024?`;
      statusCode = 503;
    } else if (message.includes("fetch failed") || message.includes("Failed to fetch")) {
      helpfulMessage = `Network error connecting to backend at ${backendUrl}. Make sure the backend server is running. Error: ${message}`;
      statusCode = 503;
    } else if (message.includes("ETIMEDOUT") || message.includes("timeout")) {
      helpfulMessage = `Connection to backend at ${backendUrl} timed out. The backend may be overloaded or unreachable.`;
      statusCode = 504;
    } else if (message.includes("ENOTFOUND")) {
      helpfulMessage = `Backend host not found. Check that ${backendUrl} is correct.`;
      statusCode = 503;
    }

    return NextResponse.json(
      {
        success: false,
        message: "Failed to connect to backend",
        error: helpfulMessage,
        backendUrl,
        debug: {
          originalError: message,
          errorType: errorName,
          env: {
            LANGGRAPH_API_URL: process.env.LANGGRAPH_API_URL ? "set" : "unset",
            NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ? "set" : "unset",
            OPEN_SWE_LOCAL_MODE: process.env.OPEN_SWE_LOCAL_MODE,
          },
        },
      },
      { status: statusCode },
    );
  }
}
