import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
import { createLogger, LogLevel } from "@openswe/shared/logger";

const logger = createLogger(LogLevel.INFO, "FeatureGraphDeleteRoute");

function resolveApiUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

/**
 * POST /api/feature-graph/delete
 *
 * Deletes a feature from the feature graph.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const workspacePath =
      typeof body?.workspace_path === "string" ? body.workspace_path.trim() : null;
    const featureId =
      typeof body?.feature_id === "string" ? body.feature_id.trim() : null;

    if (!workspacePath) {
      return NextResponse.json(
        { error: "workspace_path is required" },
        { status: 400 },
      );
    }

    if (!featureId) {
      return NextResponse.json(
        { error: "feature_id is required" },
        { status: 400 },
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
      headers[LOCAL_MODE_HEADER] = "true";
    }

    const response = await fetch(`${resolveApiUrl()}/feature-graph/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_path: workspacePath,
        feature_id: featureId,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        (data && typeof data.error === "string" ? data.error : null) ??
        "Failed to delete feature";

      logger.error("Failed to delete feature", {
        featureId,
        workspacePath,
        status: response.status,
        error: errorMessage,
      });

      return NextResponse.json(
        { error: errorMessage },
        { status: response.status },
      );
    }

    logger.info("Feature deleted", { featureId, workspacePath });

    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete feature";
    logger.error("Delete feature failed", { error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
