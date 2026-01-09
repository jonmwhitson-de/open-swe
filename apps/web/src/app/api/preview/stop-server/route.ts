import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";

/**
 * POST /api/preview/stop-server
 * Proxies to the backend to stop the dev server.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const backendUrl =
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024";

  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // No body provided, use empty object
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
      headers[LOCAL_MODE_HEADER] = "true";
    }

    const response = await fetch(`${backendUrl}/dev-server/stop`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const result = await response.json();

    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to stop dev server";
    return NextResponse.json(
      { success: false, message, error: message },
      { status: 500 },
    );
  }
}
