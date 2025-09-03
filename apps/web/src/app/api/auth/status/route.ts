import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ENABLE_GITHUB } from "@openswe/shared/config";

/**
 * API route to check GitHub authentication status
 */
export async function GET(request: NextRequest) {
  try {
    if (!ENABLE_GITHUB) {
      return NextResponse.json({ authenticated: true });
    }

    const authenticated = isAuthenticated(request);
    return NextResponse.json({ authenticated });
  } catch (error) {
    console.error("Error checking auth status:", error);
    return NextResponse.json(
      { authenticated: false, error: "Failed to check authentication status" },
      { status: 500 },
    );
  }
}
