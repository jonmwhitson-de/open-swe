import { Client } from "@langchain/langgraph-sdk";
import { MANAGER_GRAPH_ID } from "@openswe/shared/constants";
import type { ManagerGraphState } from "@openswe/shared/open-swe/manager/types";

import { createClient } from "@/providers/client";
import {
  FeatureGraphFetchResult,
  mapFeatureGraphPayload,
} from "@/lib/feature-graph-payload";

export interface FeatureDevelopmentResponse {
  plannerThreadId: string;
  runId: string;
}

/**
 * Fetch feature graph data for a thread by calling the backend load endpoint.
 * This avoids reading the graph from thread state, preventing serialization issues.
 *
 * Returns a result with null graph for expected "not ready" states (404, 409).
 * Only throws for unexpected errors.
 */
export async function fetchFeatureGraph(
  threadId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client?: Client<ManagerGraphState>,
): Promise<FeatureGraphFetchResult> {
  if (!threadId) {
    throw new Error("Thread id is required to fetch feature graph data");
  }

  // Call the state API which now proxies to the backend /feature-graph/load endpoint
  const response = await fetch(`/api/feature-graph/state?thread_id=${encodeURIComponent(threadId)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    // Handle expected "not ready" states gracefully - return empty result
    // 404: Graph not generated yet
    // 409: Thread is busy (run in progress)
    if (response.status === 404 || response.status === 409) {
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
    activeFeatureIds: payload.active_feature_ids,
    featureProposals: payload.feature_proposals?.proposals,
    activeProposalId: payload.feature_proposals?.activeProposalId,
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

export async function startFeatureDevelopmentRun(
  threadId: string,
  featureId: string,
): Promise<FeatureDevelopmentResponse> {
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
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      (payload && typeof payload.error === "string" ? payload.error : null) ??
      "Failed to start feature development";
    throw new Error(message);
  }

  const payload = await response.json();
  const { planner_thread_id: plannerThreadId, run_id: runId } = payload ?? {};

  if (typeof plannerThreadId !== "string" || typeof runId !== "string") {
    throw new Error("Invalid response when starting feature development");
  }

  return { plannerThreadId, runId } satisfies FeatureDevelopmentResponse;
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
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";
  if (!apiUrl) {
    throw new Error("API URL not configured");
  }
  return apiUrl;
}
