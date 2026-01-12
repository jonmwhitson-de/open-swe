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

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: "Invalid request body",
        error: error instanceof Error ? error.message : "Failed to parse JSON",
      },
      { status: 400 },
    );
  }

  try {
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

    // Try to parse response as JSON
    let result: unknown;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      result = await response.json();
    } else {
      const text = await response.text();
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

    // Provide more helpful error for connection issues
    let helpfulMessage = message;
    if (message.includes("ECONNREFUSED")) {
      helpfulMessage = `Cannot connect to backend at ${backendUrl}. Is the backend server running?`;
    } else if (message.includes("fetch failed")) {
      helpfulMessage = `Network error connecting to backend at ${backendUrl}. ${message}`;
    }

    return NextResponse.json(
      {
        success: false,
        message: "Failed to connect to backend",
        error: helpfulMessage,
        backendUrl,
      },
      { status: 500 },
    );
  }
}
