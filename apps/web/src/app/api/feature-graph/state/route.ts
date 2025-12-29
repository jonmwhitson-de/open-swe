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

function resolveThreadId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

/**
 * Call the backend /feature-graph/load endpoint to load the graph from file.
 * This avoids reading the graph from state and prevents serialization issues.
 */
async function loadFeatureGraphFromBackend(threadId: string): Promise<{
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
      body: JSON.stringify({ thread_id: threadId }),
    });

    const rawBody = await response.text();
    let data: unknown = null;

    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      logger.warn("Failed to parse feature graph load response", { threadId });
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
      threadId,
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
 * GET /api/feature-graph/state?thread_id=<thread_id>
 *
 * Retrieves the feature graph state by loading from file via the backend.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const threadId = resolveThreadId(searchParams.get("thread_id"));

    if (!threadId) {
      return NextResponse.json(
        { error: "thread_id query parameter is required" },
        { status: 400 },
      );
    }

    const result = await loadFeatureGraphFromBackend(threadId);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Failed to load feature graph" },
        { status: result.status },
      );
    }

    const data = result.data as {
      featureGraph?: unknown;
      activeFeatureIds?: string[];
      featureProposals?: unknown;
    } | null;

    return NextResponse.json({
      thread_id: threadId,
      feature_graph: data?.featureGraph ?? null,
      active_feature_ids: data?.activeFeatureIds ?? [],
      feature_proposals: data?.featureProposals ?? null,
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
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const threadId =
      resolveThreadId(body?.thread_id) ?? resolveThreadId(body?.threadId);

    if (!threadId) {
      return NextResponse.json(
        { error: "thread_id is required" },
        { status: 400 },
      );
    }

    const result = await loadFeatureGraphFromBackend(threadId);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Failed to load feature graph" },
        { status: result.status },
      );
    }

    const data = result.data as {
      featureGraph?: unknown;
      activeFeatureIds?: string[];
      featureProposals?: unknown;
    } | null;

    return NextResponse.json({
      thread_id: threadId,
      feature_graph: data?.featureGraph ?? null,
      active_feature_ids: data?.activeFeatureIds ?? [],
      feature_proposals: data?.featureProposals ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to retrieve feature graph state";
    logger.error("Retrieval failed", { error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
