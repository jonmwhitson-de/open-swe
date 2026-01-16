import { Client } from "@langchain/langgraph-sdk";
import { MANAGER_GRAPH_ID } from "@openswe/shared/constants";
import type { ManagerGraphState } from "@openswe/shared/open-swe/manager/types";
import { createClient, resolveApiUrl } from "@/providers/client";
import {
  FeatureGraphFetchResult,
  mapFeatureGraphPayload,
} from "@/lib/feature-graph-payload";

export interface FeatureDevelopmentResponse {
  plannerThreadId: string;
  runId: string;
}

export interface DependencyBlocker {
  id: string;
  name: string;
  description: string;
  status: string;
  development_progress?: string;
}

export interface DependencyValidationError {
  type: "dependencies_not_complete";
  message: string;
  featureId: string;
  featureName: string;
  blockedBy: DependencyBlocker[];
  suggestedNext: DependencyBlocker[];
  canForce: boolean;
}

/**
 * Fetch feature graph data using workspace path directly.
 * No thread state access needed - eliminates 409 "thread busy" errors.
 *
 * Returns a result with null graph for expected "not ready" states (404).
 * Only throws for unexpected errors.
 */
export async function fetchFeatureGraph(
  workspacePath: string,
): Promise<FeatureGraphFetchResult> {
  if (!workspacePath) {
    throw new Error("Workspace path is required to fetch feature graph data");
  }

  // Call the state API which loads directly from file - no thread state access
  const response = await fetch(`/api/feature-graph/state?workspace_path=${encodeURIComponent(workspacePath)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    // Handle expected "not ready" states gracefully - return empty result
    // 404: Graph not generated yet
    if (response.status === 404) {
      return {
        graph: null,
        activeFeatureIds: [],
        proposals: [],
        activeProposalId: null,
      };
    }

    // For other errors, throw
    const payload = await response.json().catch(() => null);
    const message =
      (payload && typeof payload.error === "string" ? payload.error : null) ??
      "Failed to load feature graph";
    throw new Error(message);
  }

  const payload = await response.json();

  // Map the response to our expected format
  const result = mapFeatureGraphPayload({
    featureGraph: payload.feature_graph,
    // activeFeatureIds and proposals are now managed separately via thread state
    // when needed, not through the graph load endpoint
    activeFeatureIds: [],
    featureProposals: [],
    activeProposalId: null,
  });

  return result;
}

export async function requestFeatureGraphGeneration(
  threadId: string,
  client?: Client<ManagerGraphState>,
): Promise<void> {
  if (!threadId) {
    throw new Error(
      "Thread id is required to request feature graph generation",
    );
  }

  const resolvedClient = client ?? createClient(getApiUrl());

  const run = await resolvedClient.runs.create(threadId, MANAGER_GRAPH_ID, {
    input: {
      action: "generate_feature_graph",
      messages: [
        {
          role: "user",
          content: "Requesting feature graph generation",
          additional_kwargs: {
            phase: "design",
            requestSource: "open-swe",
          },
        },
      ],
    },
    config: {
      configurable: {
        phase: "design",
        thread_id: threadId,
      },
    },
    ifNotExists: "create",
  });

  await resolvedClient.threads.patchState(threadId, {
    configurable: {
      phase: "design",
      thread_id: threadId,
      run_id: run.run_id,
    },
  });
}

export type StartFeatureDevelopmentResult =
  | { success: true; response: FeatureDevelopmentResponse }
  | { success: false; dependencyError: DependencyValidationError };

/**
 * Start feature development with dependency validation.
 * Returns either success with planner info, or dependency error with options.
 */
export async function startFeatureDevelopmentRun(
  threadId: string,
  featureId: string,
  options?: { force?: boolean },
): Promise<StartFeatureDevelopmentResult> {
  if (!threadId) {
    throw new Error("Thread id is required to start feature development");
  }

  if (!featureId) {
    throw new Error("Feature id is required to start feature development");
  }

  const response = await fetch("/api/feature-graph/develop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      thread_id: threadId,
      feature_id: featureId,
      force: options?.force ?? false,
    }),
  });

  const payload = await response.json().catch(() => null);

  // Handle dependency validation error (409 Conflict)
  if (response.status === 409 && payload?.error === "dependencies_not_complete") {
    return {
      success: false,
      dependencyError: {
        type: "dependencies_not_complete",
        message: payload.message ?? "Feature has incomplete dependencies",
        featureId: payload.feature_id ?? featureId,
        featureName: payload.feature_name ?? featureId,
        blockedBy: payload.blocked_by ?? [],
        suggestedNext: payload.suggested_next ?? [],
        canForce: payload.can_force ?? false,
      },
    };
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload.error === "string" ? payload.error : null) ??
      "Failed to start feature development";
    throw new Error(message);
  }

  const { planner_thread_id: plannerThreadId, run_id: runId } = payload ?? {};

  if (typeof plannerThreadId !== "string" || typeof runId !== "string") {
    throw new Error("Invalid response when starting feature development");
  }

  return {
    success: true,
    response: { plannerThreadId, runId },
  };
}

export type FeatureProposalAction = "approve" | "reject" | "info";

export interface FeatureProposalActionResponse extends FeatureGraphFetchResult {
  message: string | null;
}

export async function performFeatureProposalAction({
  threadId,
  proposalId,
  featureId,
  action,
  rationale,
}: {
  threadId: string;
  proposalId: string;
  featureId: string;
  action: FeatureProposalAction;
  rationale?: string;
}): Promise<FeatureProposalActionResponse> {
  const response = await fetch("/api/feature-graph/proposal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      thread_id: threadId,
      proposal_id: proposalId,
      feature_id: featureId,
      action,
      rationale,
    }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      (payload && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : null) ?? "Failed to process proposal action";
    throw new Error(message);
  }

  const result = mapFeatureGraphPayload(payload);

  return {
    ...result,
    message: result.message ?? "Proposal updated",
  } satisfies FeatureProposalActionResponse;
}

function getApiUrl(): string {
  // Resolve API URL to absolute URL (handles relative URLs like /api)
  return resolveApiUrl(process.env.NEXT_PUBLIC_API_URL ?? "/api");
}
