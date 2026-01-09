import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";

/**
 * POST /api/preview/start-server
 * Proxies to the backend to start a dev server.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const backendUrl =
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024";

  try {
    const body = await request.json();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
      headers[LOCAL_MODE_HEADER] = "true";
    }

    const response = await fetch(`${backendUrl}/dev-server/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const result = await response.json();

    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start dev server";
    return NextResponse.json(
      { success: false, message, error: message },
      { status: 500 },
    );
  }
}
