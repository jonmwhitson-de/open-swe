import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy route for preview functionality.
 * Routes requests to localhost:<port>/<path> to avoid CORS and networking issues.
 *
 * Usage: /api/preview/<port>/<path>
 * Example: /api/preview/3000/api/users -> http://localhost:3000/api/users
 */

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
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

// Headers to forward from the upstream response
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
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

async function handleRequest(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const resolvedParams = await params;
  const { port: portStr, path: pathSegments } = resolvedParams;

  // Validate port
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < MIN_PORT || port > MAX_PORT) {
    return NextResponse.json(
      { error: "Invalid port number" },
      { status: 400 },
    );
  }

  // Construct the target URL
  const targetPath = pathSegments?.join("/") || "";
  const targetUrl = new URL(`http://localhost:${port}/${targetPath}`);

  // Copy query parameters
  request.nextUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value);
  });

  try {
    // Build headers to forward
    const headers: Record<string, string> = {};
    FORWARD_REQUEST_HEADERS.forEach((header) => {
      const value = request.headers.get(header);
      if (value) {
        headers[header] = value;
      }
    });

    // Add custom header to identify proxy requests
    headers["x-openswe-preview-proxy"] = "true";

    // Prepare request body for methods that support it
    let body: BodyInit | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        body = await request.text();
      } catch {
        // No body or failed to read
      }
    }

    // Make the proxied request
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: "manual", // Handle redirects ourselves
    });

    // Build response headers
    const responseHeaders = new Headers();
    FORWARD_RESPONSE_HEADERS.forEach((header) => {
      const value = response.headers.get(header);
      if (value) {
        // Handle location header for redirects - rewrite to go through proxy
        if (header === "location") {
          try {
            const locationUrl = new URL(value, targetUrl);
            if (locationUrl.hostname === "localhost" && locationUrl.port === String(port)) {
              // Rewrite to proxy URL
              const proxyPath = `/api/preview/${port}${locationUrl.pathname}${locationUrl.search}`;
              responseHeaders.set(header, proxyPath);
              return;
            }
          } catch {
            // Not a valid URL, forward as-is
          }
        }
        responseHeaders.set(header, value);
      }
    });

    // Add CORS headers to allow iframe access
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
    responseHeaders.set("Access-Control-Allow-Headers", FORWARD_REQUEST_HEADERS.join(", "));

    // Remove X-Frame-Options if present (allows embedding in iframe)
    // Note: The upstream app may set this, we remove it to allow preview
    responseHeaders.delete("x-frame-options");

    // Handle different response types
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      // For HTML responses, we may need to rewrite URLs
      let html = await response.text();

      // Rewrite absolute URLs to localhost to go through proxy
      // This is a simple approach - may need enhancement for complex apps
      html = html.replace(
        new RegExp(`(src|href|action)=["']http://localhost:${port}/`, "gi"),
        `$1="/api/preview/${port}/`,
      );
      html = html.replace(
        new RegExp(`(src|href|action)=["']/(?!api/preview)`, "gi"),
        `$1="/api/preview/${port}/`,
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
    // Connection refused or other network error
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("ECONNREFUSED")) {
      return NextResponse.json(
        {
          error: "Connection refused",
          message: `No server running on port ${port}. Start your development server first.`,
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

export async function OPTIONS(request: NextRequest, params: RouteParams) {
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
