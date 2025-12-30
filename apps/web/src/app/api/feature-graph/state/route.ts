import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
import { createLogger, LogLevel } from "@openswe/shared/logger";

const logger = createLogger(LogLevel.INFO, "FeatureGraphStateRoute");

function resolveApiUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

function resolveWorkspacePath(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

/**
 * Call the backend /feature-graph/load endpoint to load the graph from file.
 * Uses workspace_path directly - no thread state access needed.
 */
async function loadFeatureGraphFromBackend(workspacePath: string): Promise<{
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
    headers[LOCAL_MODE_HEADER] = "true";
  }

  try {
    const response = await fetch(`${resolveApiUrl()}/feature-graph/load`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace_path: workspacePath }),
    });

    const rawBody = await response.text();
    let data: unknown = null;

    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      logger.warn("Failed to parse feature graph load response", { workspacePath });
    }

    if (!response.ok) {
      const errorMessage =
        (data && typeof (data as { error?: unknown })?.error === "string"
          ? (data as { error: string }).error
          : rawBody || response.statusText || "Failed to load feature graph") ??
        "Failed to load feature graph";

      return { ok: false, status: response.status, data: null, error: errorMessage };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    logger.error("Failed to call feature graph load endpoint", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      ok: false,
      status: 500,
      data: null,
      error: error instanceof Error ? error.message : "Failed to load feature graph",
    };
  }
}

/**
 * GET /api/feature-graph/state?workspace_path=<workspace_path>
 *
 * Retrieves the feature graph state by loading from file via the backend.
 * Uses workspace_path directly - no thread state access needed.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const workspacePath =
      resolveWorkspacePath(searchParams.get("workspace_path")) ??
      resolveWorkspacePath(searchParams.get("workspacePath"));

    if (!workspacePath) {
      return NextResponse.json(
        { error: "workspace_path query parameter is required" },
        { status: 400 },
      );
    }

    const result = await loadFeatureGraphFromBackend(workspacePath);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Failed to load feature graph" },
        { status: result.status },
      );
    }

    const data = result.data as {
      featureGraph?: unknown;
    } | null;

    return NextResponse.json({
      workspace_path: workspacePath,
      feature_graph: data?.featureGraph ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to retrieve feature graph state";
    logger.error("Retrieval failed", { error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/feature-graph/state
 *
 * Alternative POST endpoint for retrieving state (for clients that prefer POST).
 * Uses workspace_path directly - no thread state access needed.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const workspacePath =
      resolveWorkspacePath(body?.workspace_path) ??
      resolveWorkspacePath(body?.workspacePath);

    if (!workspacePath) {
      return NextResponse.json(
        { error: "workspace_path is required" },
        { status: 400 },
      );
    }

    const result = await loadFeatureGraphFromBackend(workspacePath);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Failed to load feature graph" },
        { status: result.status },
      );
    }

    const data = result.data as {
      featureGraph?: unknown;
    } | null;

    return NextResponse.json({
      workspace_path: workspacePath,
      feature_graph: data?.featureGraph ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to retrieve feature graph state";
    logger.error("Retrieval failed", { error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
