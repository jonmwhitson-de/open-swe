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

  console.log("[start-server] Backend URL:", backendUrl);
  console.log("[start-server] Environment:", {
    LANGGRAPH_API_URL: process.env.LANGGRAPH_API_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    OPEN_SWE_LOCAL_MODE: process.env.OPEN_SWE_LOCAL_MODE,
  });

  let body: unknown;
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
