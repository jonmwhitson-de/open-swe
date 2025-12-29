import { NextRequest, NextResponse } from "next/server";
import { Client } from "@langchain/langgraph-sdk";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
import type { ManagerGraphState } from "@openswe/shared/open-swe/manager/types";
import type { GraphConfig } from "@openswe/shared/open-swe/types";
import { getCustomConfigurableFields } from "@openswe/shared/open-swe/utils/config";
import { createLogger, LogLevel } from "@openswe/shared/logger";

import { mapFeatureGraphPayload } from "@/lib/feature-graph-payload";

const logger = createLogger(LogLevel.INFO, "FeatureGraphGenerateRoute");

function resolveApiUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

function resolveThreadId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function resolvePrompt(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

async function requestGraphGeneration({
  threadId,
  workspaceAbsPath,
  prompt,
  configurable,
}: {
  threadId: string;
  workspaceAbsPath: string;
  prompt: string;
  configurable?: Record<string, unknown>;
}): Promise<{
  ok: boolean;
  status: number;
  payload: unknown;
  message: string;
  rawBody?: string;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
    headers[LOCAL_MODE_HEADER] = "true";
  }

  logger.info("Requesting feature graph generation", {
    threadId,
    workspaceAbsPath,
    configurablePresent: Boolean(configurable),
  });

  const response = await fetch(`${resolveApiUrl()}/feature-graph/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspaceAbsPath,
      prompt,
      configurable,
    }),
  });

  const rawBody = await response.text();
  let payload: unknown = null;

  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch (error) {
    logger.warn("Failed to parse feature graph generation response", {
      threadId,
      workspaceAbsPath,
      error,
    });
  }

  const message =
    (payload && typeof (payload as { error?: unknown })?.error === "string"
      ? (payload as { error: string }).error
      : rawBody || response.statusText || "Failed to generate feature graph") ??
    "Failed to generate feature graph";

  return {
    ok: response.ok,
    status: response.status,
    payload,
    message,
    rawBody,
  };
}

function redactMessage(message: string, workspaceAbsPath?: string): string {
  if (!workspaceAbsPath) {
    return message;
  }

  return message.replaceAll(workspaceAbsPath, "[redacted]");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const threadId =
      resolveThreadId(body?.thread_id) ?? resolveThreadId(body?.threadId);
    const prompt = resolvePrompt(body?.prompt);

    if (!threadId) {
      return NextResponse.json(
        { error: "thread_id is required" },
        { status: 400 },
      );
    }

    if (!prompt) {
      return NextResponse.json(
        { error: "prompt is required" },
        { status: 400 },
      );
    }

    const client = new Client({
      apiUrl: resolveApiUrl(),
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    // Retry getState with exponential backoff if thread is busy
    const maxRetries = 3;
    let lastError: unknown = null;
    let managerState = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        managerState = await client.threads.getState<ManagerGraphState>(threadId);
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number })?.status;

        // Only retry on 409 (thread busy) errors
        if (status === 409 && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 500; // 500ms, 1000ms, 2000ms
          logger.warn(`Thread busy, retrying getState in ${delay}ms`, {
            threadId,
            attempt: attempt + 1,
            maxRetries,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable error or final attempt
        logger.error("Failed to load manager state for feature graph", {
          threadId,
          status,
          error,
        });
        break;
      }
    }

    if (!managerState?.values) {
      const status = (lastError as { status?: number })?.status ?? 404;
      const message = status === 409
        ? "Thread is busy, please try again later"
        : status === 404
          ? "Manager state not found for thread"
          : "Failed to load manager state";
      return NextResponse.json({ error: message }, { status });
    }

    const workspaceAbsPath =
      managerState.values.workspaceAbsPath ?? managerState.values.workspacePath;
    if (!workspaceAbsPath) {
      return NextResponse.json(
        { error: "Workspace path unavailable for this thread" },
        { status: 400 },
      );
    }

    const configurableFields =
      getCustomConfigurableFields({
        configurable: managerState.metadata
          ?.configurable as GraphConfig["configurable"],
      } as GraphConfig) ?? {};

    const generation = await requestGraphGeneration({
      threadId,
      workspaceAbsPath,
      prompt,
      configurable:
        Object.keys(configurableFields).length > 0
          ? configurableFields
          : undefined,
    });

    if (!generation.ok) {
      const redactedMessage = redactMessage(generation.message, workspaceAbsPath);
      const redactedRawBody = redactMessage(generation.rawBody ?? "", workspaceAbsPath);

      return NextResponse.json(
        {
          error: redactedMessage,
          upstream: {
            status: generation.status,
            message: redactedRawBody || undefined,
          },
        },
        { status: generation.status },
      );
    }

    const payload = generation.payload;

    const { graph, activeFeatureIds } = mapFeatureGraphPayload(payload);

    if (!graph) {
      logger.error("Feature graph generation payload was invalid", {
        threadId,
        workspaceAbsPath,
        payload,
      });

      return NextResponse.json(
        { error: "Generated feature graph payload was invalid" },
        { status: 500 },
      );
    }

    // Only update activeFeatureIds in state - don't store featureGraph in state
    // to avoid state growing too large. The graph is persisted to file by the
    // backend generation service and loaded from file when needed.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { featureGraph: _excludedGraph, ...restManagerState } = managerState.values;

    // Try to update state, but don't fail the whole operation if thread is busy.
    // The graph is already persisted to file, so activeFeatureIds update is nice-to-have.
    try {
      await client.threads.updateState<ManagerGraphState>(threadId, {
        values: {
          ...restManagerState,
          activeFeatureIds,
        },
        asNode: "feature-graph-orchestrator",
      });
    } catch (updateError) {
      logger.warn("Failed to update thread state after generation (thread may be busy)", {
        threadId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
      // Continue anyway - the graph is persisted to file
    }

    return NextResponse.json({
      featureGraph: graph,
      activeFeatureIds,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate feature graph";

    logger.error("Failed to handle feature graph generation request", {
      error,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
