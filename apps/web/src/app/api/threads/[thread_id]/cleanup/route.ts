import { NextRequest, NextResponse } from "next/server";
import { Client } from "@langchain/langgraph-sdk";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
import type { ManagerGraphState } from "@openswe/shared/open-swe/manager/types";
import { createLogger, LogLevel } from "@openswe/shared/logger";

const logger = createLogger(LogLevel.INFO, "ThreadCleanupRoute");

function resolveApiUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

/**
 * POST /api/threads/[thread_id]/cleanup
 *
 * Cleans up corrupted thread state by removing the large featureGraph field.
 * This fixes RangeError: Invalid string length errors caused by state serialization.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ thread_id: string }> }
): Promise<NextResponse> {
  const { thread_id: threadId } = await params;

  if (!threadId) {
    return NextResponse.json(
      { error: "thread_id is required" },
      { status: 400 }
    );
  }

  logger.info("Starting thread state cleanup", { threadId });

  const client = new Client({
    apiUrl: resolveApiUrl(),
    defaultHeaders:
      process.env.OPEN_SWE_LOCAL_MODE === "true"
        ? { [LOCAL_MODE_HEADER]: "true" }
        : undefined,
  });

  try {
    // First, try to get the current state
    let currentState: Awaited<ReturnType<typeof client.threads.getState<ManagerGraphState>>> | null = null;

    try {
      currentState = await client.threads.getState<ManagerGraphState>(threadId);
    } catch (error) {
      const status = (error as { status?: number })?.status;

      if (status === 404) {
        return NextResponse.json(
          { error: "Thread not found" },
          { status: 404 }
        );
      }

      // If we get RangeError or other errors, the state is likely corrupted
      // Try to patch the state directly to remove featureGraph
      logger.warn("Failed to load state, attempting direct cleanup", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (currentState?.values) {
      // Check if featureGraph exists and is large
      const hasFeatureGraph = "featureGraph" in currentState.values && currentState.values.featureGraph != null;

      if (!hasFeatureGraph) {
        return NextResponse.json({
          success: true,
          message: "Thread state is already clean (no featureGraph found)",
          threadId,
        });
      }

      // Remove featureGraph from values
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { featureGraph: _removed, ...cleanedValues } = currentState.values;

      // Update state without featureGraph
      await client.threads.updateState<ManagerGraphState>(threadId, {
        values: cleanedValues,
        asNode: "cleanup",
      });

      logger.info("Successfully cleaned thread state", { threadId });

      return NextResponse.json({
        success: true,
        message: "Thread state cleaned successfully - featureGraph removed",
        threadId,
        hadFeatureGraph: true,
      });
    } else {
      // State couldn't be loaded - try a different approach
      // We can try to patch just the featureGraph field to null
      try {
        await client.threads.updateState<ManagerGraphState>(threadId, {
          values: {
            featureGraph: undefined,
          } as unknown as ManagerGraphState,
          asNode: "cleanup",
        });

        logger.info("Attempted to clear featureGraph via patch", { threadId });

        return NextResponse.json({
          success: true,
          message: "Attempted to clear featureGraph - state was not readable",
          threadId,
          note: "State may still need manual cleanup if this doesn't work",
        });
      } catch (patchError) {
        logger.error("Failed to patch thread state", {
          threadId,
          error: patchError instanceof Error ? patchError.message : String(patchError),
        });

        return NextResponse.json(
          {
            error: "Failed to clean thread state - state may be too corrupted",
            details: patchError instanceof Error ? patchError.message : String(patchError),
          },
          { status: 500 }
        );
      }
    }
  } catch (error) {
    logger.error("Thread cleanup failed", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        error: "Failed to clean thread state",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
