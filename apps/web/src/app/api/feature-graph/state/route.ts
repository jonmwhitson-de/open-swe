import { NextRequest, NextResponse } from "next/server";
import { Client } from "@langchain/langgraph-sdk";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
import type { ManagerGraphState } from "@openswe/shared/open-swe/manager/types";
import { coerceFeatureGraph } from "@/lib/coerce-feature-graph";
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
 * GET /api/feature-graph/state?thread_id=<thread_id>
 *
 * Retrieves the feature graph state from a manager thread.
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

    const client = new Client({
      apiUrl: resolveApiUrl(),
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    const managerState = await client.threads
      .getState<ManagerGraphState>(threadId)
      .catch((error) => {
        const status = (error as { status?: number })?.status ?? 500;
        logger.error("Failed to load manager state for feature graph", {
          threadId,
          status,
          error,
        });

        const message =
          status === 404
            ? "Manager state not found for thread"
            : "Failed to load manager state";

        return NextResponse.json({ error: message }, { status });
      });

    if (managerState instanceof NextResponse) {
      return managerState;
    }

    if (!managerState?.values) {
      return NextResponse.json(
        { error: "Manager state not found for thread" },
        { status: 404 },
      );
    }

    // Extract feature graph from manager state
    const rawFeatureGraph = managerState.values.featureGraph;
    const featureGraph = coerceFeatureGraph(rawFeatureGraph);

    if (!featureGraph) {
      return NextResponse.json(
        {
          error: "Feature graph not available for this thread",
          hint: "Generate a feature graph first using /api/feature-graph/generate"
        },
        { status: 404 },
      );
    }

    // Serialize the feature graph for response
    const serialized = featureGraph.toJSON();

    return NextResponse.json({
      thread_id: threadId,
      feature_graph: {
        version: serialized.version,
        nodes: serialized.nodes,
        edges: serialized.edges,
        artifacts: serialized.artifacts,
      },
      active_feature_ids: managerState.values.activeFeatureIds ?? [],
      feature_proposals: managerState.values.featureProposals ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to retrieve feature graph state";
    logger.error("Feature graph state retrieval failed", { error });
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

    const client = new Client({
      apiUrl: resolveApiUrl(),
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    const managerState = await client.threads
      .getState<ManagerGraphState>(threadId)
      .catch((error) => {
        const status = (error as { status?: number })?.status ?? 500;
        logger.error("Failed to load manager state for feature graph", {
          threadId,
          status,
          error,
        });

        const message =
          status === 404
            ? "Manager state not found for thread"
            : "Failed to load manager state";

        return NextResponse.json({ error: message }, { status });
      });

    if (managerState instanceof NextResponse) {
      return managerState;
    }

    if (!managerState?.values) {
      return NextResponse.json(
        { error: "Manager state not found for thread" },
        { status: 404 },
      );
    }

    // Extract feature graph from manager state
    const rawFeatureGraph = managerState.values.featureGraph;
    const featureGraph = coerceFeatureGraph(rawFeatureGraph);

    if (!featureGraph) {
      return NextResponse.json(
        {
          error: "Feature graph not available for this thread",
          hint: "Generate a feature graph first using /api/feature-graph/generate"
        },
        { status: 404 },
      );
    }

    // Serialize the feature graph for response
    const serialized = featureGraph.toJSON();

    return NextResponse.json({
      thread_id: threadId,
      feature_graph: {
        version: serialized.version,
        nodes: serialized.nodes,
        edges: serialized.edges,
        artifacts: serialized.artifacts,
      },
      active_feature_ids: managerState.values.activeFeatureIds ?? [],
      feature_proposals: managerState.values.featureProposals ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to retrieve feature graph state";
    logger.error("Feature graph state retrieval failed", { error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
