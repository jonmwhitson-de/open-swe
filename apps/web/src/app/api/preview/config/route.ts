import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

/**
 * POST /api/preview/config
 *
 * Reads preview.json from the workspace to get preview configuration.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { workspacePath, sandboxSessionId } = body;

    // Determine the workspace path
    let targetPath = workspacePath;

    if (!targetPath) {
      // Try to find workspace from local repos dir
      const localReposDir = process.env.OPEN_SWE_LOCAL_REPOS_DIR || "/tmp/open-swe-workspaces";

      // For now, use a default path or return empty config
      // In production, this would be determined by the sandbox session
      const entries = await fs.readdir(localReposDir).catch(() => []);
      if (entries.length > 0) {
        targetPath = path.join(localReposDir, entries[0]);
      }
    }

    if (!targetPath) {
      return NextResponse.json(
        { error: "No workspace path available" },
        { status: 400 }
      );
    }

    // Read preview.json from the workspace
    const previewJsonPath = path.join(targetPath, "preview.json");

    try {
      const content = await fs.readFile(previewJsonPath, "utf-8");
      const config = JSON.parse(content);

      console.log("[preview/config] Loaded preview.json:", config);

      return NextResponse.json(config);
    } catch (readError) {
      // preview.json doesn't exist yet
      console.log("[preview/config] preview.json not found at:", previewJsonPath);
      return NextResponse.json(null);
    }
  } catch (error) {
    console.error("[preview/config] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load preview config" },
      { status: 500 }
    );
  }
}
