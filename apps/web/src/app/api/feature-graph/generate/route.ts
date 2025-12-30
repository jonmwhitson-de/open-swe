import { NextRequest, NextResponse } from "next/server";
import { LOCAL_MODE_HEADER } from "@openswe/shared/constants";
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

function resolveWorkspacePath(value: unknown): string | null {
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
  workspaceAbsPath,
  prompt,
  configurable,
}: {
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
    const workspaceAbsPath =
      resolveWorkspacePath(body?.workspace_path) ??
      resolveWorkspacePath(body?.workspacePath) ??
      resolveWorkspacePath(body?.workspaceAbsPath);
    const prompt = resolvePrompt(body?.prompt);
    const configurable = body?.configurable as Record<string, unknown> | undefined;

    if (!workspaceAbsPath) {
      return NextResponse.json(
        { error: "workspace_path is required" },
        { status: 400 },
      );
    }

    if (!prompt) {
      return NextResponse.json(
        { error: "prompt is required" },
        { status: 400 },
      );
    }

    // Generate feature graph directly using workspace path - no thread state access needed
    // This eliminates 409 "thread busy" errors
    const generation = await requestGraphGeneration({
      workspaceAbsPath,
      prompt,
      configurable,
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
        workspaceAbsPath,
        payload,
      });

      return NextResponse.json(
        { error: "Generated feature graph payload was invalid" },
        { status: 500 },
      );
    }

    // The graph is persisted to file by the backend generation service.
    // activeFeatureIds are returned to the caller who can store them locally.
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
