import { Client } from "@langchain/langgraph-sdk";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";

/**
 * Normalizes hostname to ensure consistent URL construction.
 * Treats 127.0.0.1 and localhost as equivalent to avoid client mismatch issues.
 */
function normalizeHost(host: string): string {
  // Normalize 127.0.0.1 to localhost for consistency
  return host.replace(/^127\.0\.0\.1(:\d+)?$/, (match, port) => `localhost${port || ""}`);
}

/**
 * Resolves a potentially relative URL to an absolute URL.
 * Handles both server-side and client-side contexts.
 */
export function resolveApiUrl(apiUrl: string): string {
  // If already absolute, return as-is
  if (apiUrl.startsWith("http://") || apiUrl.startsWith("https://")) {
    return apiUrl;
  }

  // On client-side, use window.location to construct absolute URL
  if (typeof window !== "undefined") {
    const host = normalizeHost(window.location.host);
    const baseUrl = `${window.location.protocol}//${host}`;
    return `${baseUrl}${apiUrl.startsWith("/") ? "" : "/"}${apiUrl}`;
  }

  // On server-side, fallback to localhost:3000
  return `http://localhost:3000${apiUrl.startsWith("/") ? "" : "/"}${apiUrl}`;
}

export function createClient(apiUrl: string) {
  const resolvedUrl = resolveApiUrl(apiUrl);
  const defaultHeaders =
    process.env.NEXT_PUBLIC_OPEN_SWE_LOCAL_MODE === "true"
      ? { [LOCAL_MODE_HEADER]: "true" }
      : undefined;

  return new Client({
    apiUrl: resolvedUrl,
    defaultHeaders,
  });
}
