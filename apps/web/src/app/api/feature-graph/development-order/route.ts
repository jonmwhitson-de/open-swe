import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";

function resolveApiUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

/**
 * POST /api/feature-graph/development-order
 *
 * Get the optimal development order for features based on dependencies.
 * Returns features sorted topologically - dependencies first.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const workspacePath =
      typeof body?.workspace_path === "string" ? body.workspace_path.trim() : null;
    const featureIds = Array.isArray(body?.feature_ids) ? body.feature_ids : undefined;
    const includeCompleted = body?.include_completed === true;

    if (!workspacePath) {
      return NextResponse.json(
        { error: "workspace_path is required" },
        { status: 400 },
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
      headers[LOCAL_MODE_HEADER] = "true";
    }

    const response = await fetch(`${resolveApiUrl()}/feature-graph/development-order`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_path: workspacePath,
        feature_ids: featureIds,
        include_completed: includeCompleted,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        (data && typeof data.error === "string" ? data.error : null) ??
        "Failed to get development order";

      return NextResponse.json(
        { error: errorMessage },
        { status: response.status },
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to get development order";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
