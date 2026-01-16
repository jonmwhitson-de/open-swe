import { useState, useEffect } from "react";

/**
 * Normalizes hostname to ensure consistent URL construction.
 * Treats 127.0.0.1 and localhost as equivalent to avoid client mismatch issues.
 */
function normalizeHost(host: string): string {
  // Normalize 127.0.0.1 to localhost for consistency
  return host.replace(/^127\.0\.0\.1(:\d+)?$/, (match, port) => `localhost${port || ""}`);
}

/**
 * Hook that returns the resolved API URL based on the current window location.
 * Returns an empty string during SSR and updates to the correct URL on client mount.
 */
export function useApiUrl(): string {
  const [apiUrl, setApiUrl] = useState<string>("");

  useEffect(() => {
    const envUrl = process.env.NEXT_PUBLIC_API_URL ?? "/api";

    // If already absolute, use as-is
    if (envUrl.startsWith("http://") || envUrl.startsWith("https://")) {
      setApiUrl(envUrl);
      return;
    }

    // On client-side, resolve relative URL using window.location
    if (typeof window !== "undefined") {
      const host = normalizeHost(window.location.host);
      const baseUrl = `${window.location.protocol}//${host}`;
      const resolved = `${baseUrl}${envUrl.startsWith("/") ? "" : "/"}${envUrl}`;
      setApiUrl(resolved);
    }
  }, []);

  return apiUrl;
}
