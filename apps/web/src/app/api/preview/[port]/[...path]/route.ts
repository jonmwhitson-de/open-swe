import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";

/**
 * Proxy route for preview functionality with path.
 * Routes requests through the backend to access the dev server.
 * This allows the preview to work even when the dev server is running
 * on a remote server that the client can't directly access.
 *
 * Usage: /api/preview/<port>/<path>
 * Example: /api/preview/3000/api/users -> backend -> localhost:3000/api/users
 */

const ALLOWED_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
];
const MAX_PORT = 65535;
const MIN_PORT = 1;

// Headers to forward from the client request
const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "x-requested-with",
  "cache-control",
];

// Headers to forward from the backend response
// Note: content-length is intentionally excluded because we may modify the response body
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "set-cookie",
  "location",
];

interface RouteParams {
  params: Promise<{
    port: string;
    path: string[];
  }>;
}

function getBackendUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

async function handleRequest(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const resolvedParams = await params;
  const { port: portStr, path: pathSegments } = resolvedParams;

  // Validate port
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < MIN_PORT || port > MAX_PORT) {
    return NextResponse.json({ error: "Invalid port number" }, { status: 400 });
  }

  // Construct the backend proxy URL
  const targetPath = pathSegments?.join("/") || "";
  const backendUrl = getBackendUrl();
  const targetUrl = new URL(`${backendUrl}/dev-server/proxy/${port}/${targetPath}`);

  // Copy query parameters (including sandboxSessionId for port mapping lookup)
  request.nextUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value);
  });

  // Ensure sandboxSessionId is passed through for port mapping
  const sandboxSessionId = request.nextUrl.searchParams.get("sandboxSessionId");
  if (sandboxSessionId && !targetUrl.searchParams.has("sandboxSessionId")) {
    targetUrl.searchParams.set("sandboxSessionId", sandboxSessionId);
  }

  try {
    // Build headers to forward
    const headers: Record<string, string> = {};
    FORWARD_REQUEST_HEADERS.forEach((header) => {
      const value = request.headers.get(header);
      if (value) {
        headers[header] = value;
      }
    });

    // Add local mode header if configured
    if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
      headers[LOCAL_MODE_HEADER] = "true";
    }

    // Prepare request body for methods that support it
    let body: BodyInit | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        body = await request.text();
      } catch {
        // No body or failed to read
      }
    }

    // Make the proxied request to the backend
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    // Build response headers
    const responseHeaders = new Headers();
    FORWARD_RESPONSE_HEADERS.forEach((header) => {
      const value = response.headers.get(header);
      if (value) {
        // Handle location header for redirects - rewrite backend proxy URLs to frontend proxy URLs
        if (header === "location") {
          try {
            // Rewrite /dev-server/proxy/<port>/... to /api/preview/<port>/...
            const rewritten = value.replace(
              /\/dev-server\/proxy\/(\d+)\//g,
              "/api/preview/$1/",
            );
            responseHeaders.set(header, rewritten);
            return;
          } catch {
            // Forward as-is
          }
        }
        responseHeaders.set(header, value);
      }
    });

    // Add CORS headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set(
      "Access-Control-Allow-Methods",
      ALLOWED_METHODS.join(", "),
    );
    responseHeaders.set(
      "Access-Control-Allow-Headers",
      FORWARD_REQUEST_HEADERS.join(", "),
    );

    // Remove X-Frame-Options if present (allows embedding in iframe)
    responseHeaders.delete("x-frame-options");

    // Handle different response types
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      // For HTML responses, rewrite backend proxy URLs to frontend proxy URLs
      let html = await response.text();

      // Replace ALL occurrences of /dev-server/proxy/<port> with /api/preview/<port>
      // This catches URLs in attributes, inline scripts, base tags, etc.
      html = html.replace(
        /\/dev-server\/proxy\/(\d+)/g,
        "/api/preview/$1",
      );

      return new NextResponse(html, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // For other content types, stream the response
    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("ECONNREFUSED")) {
      return NextResponse.json(
        {
          error: "Backend unavailable",
          message:
            "Cannot connect to the backend server. Please ensure it is running.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        error: "Proxy error",
        message: errorMessage,
      },
      { status: 502 },
    );
  }
}

// Handle all HTTP methods
export async function GET(request: NextRequest, params: RouteParams) {
  return handleRequest(request, params);
}

export async function POST(request: NextRequest, params: RouteParams) {
  return handleRequest(request, params);
}

export async function PUT(request: NextRequest, params: RouteParams) {
  return handleRequest(request, params);
}

export async function PATCH(request: NextRequest, params: RouteParams) {
  return handleRequest(request, params);
}

export async function DELETE(request: NextRequest, params: RouteParams) {
  return handleRequest(request, params);
}

export async function OPTIONS() {
  // Handle CORS preflight
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
      "Access-Control-Allow-Headers": FORWARD_REQUEST_HEADERS.join(", "),
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function HEAD(request: NextRequest, params: RouteParams) {
  return handleRequest(request, params);
}
