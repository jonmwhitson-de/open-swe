import { randomUUID } from "crypto";
import path from "node:path";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { StreamMode } from "@langchain/langgraph-sdk";
import {
  clarifyFeatureDescription,
  FeatureGraph,
  loadFeatureGraph,
} from "@openswe/shared/feature-graph";
import type { FeatureNode } from "@openswe/shared/feature-graph/types";
import {
  LOCAL_MODE_HEADER,
  OPEN_SWE_STREAM_MODE,
  PLANNER_GRAPH_ID,
} from "@openswe/shared/constants";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  FeatureProposal,
  FeatureProposalState,
  ManagerGraphState,
  ManagerGraphUpdate,
} from "@openswe/shared/open-swe/manager/types";
import type { PlannerGraphUpdate } from "@openswe/shared/open-swe/planner/types";
import { getCustomConfigurableFields } from "@openswe/shared/open-swe/utils/config";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { resolveInsideRoot } from "./run.js";
import { generateFeatureGraphForWorkspace } from "../../graphs/manager/utils/generate-feature-graph.js";
import {
  applyFeatureStatus,
  persistFeatureGraph,
  reconcileFeatureGraphDependencies,
} from "../../graphs/manager/utils/feature-graph-mutations.js";
import { createLangGraphClient } from "../../utils/langgraph-client.js";
import { FEATURE_GRAPH_RELATIVE_PATH } from "../../graphs/manager/utils/feature-graph-path.js";

const logger = createLogger(LogLevel.INFO, "FeatureGraphRoute");

/**
 * Load the feature graph from file for a given workspace path.
 * Returns null if the graph file doesn't exist or can't be parsed.
 */
async function loadFeatureGraphFromFile(
  workspacePath: string | undefined,
): Promise<FeatureGraph | null> {
  if (!workspacePath) return null;

  const graphPath = path.join(workspacePath, FEATURE_GRAPH_RELATIVE_PATH);

  try {
    const data = await loadFeatureGraph(graphPath);
    return new FeatureGraph(data);
  } catch (error) {
    logger.warn("Failed to load feature graph from file", {
      graphPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

type GenerateRequestBody = {
  workspaceAbsPath?: unknown;
  configurable?: Record<string, unknown>;
  prompt?: unknown;
};

type DevelopRequestBody = {
  thread_id?: unknown;
  threadId?: unknown;
  feature_id?: unknown;
  featureId?: unknown;
};

type ProposalActionRequestBody = {
  thread_id?: unknown;
  threadId?: unknown;
  feature_id?: unknown;
  featureId?: unknown;
  proposal_id?: unknown;
  proposalId?: unknown;
  action?: unknown;
  rationale?: unknown;
};

export function registerFeatureGraphRoute(app: Hono) {
  app.post("/feature-graph/generate", async (ctx) => {
    let body: GenerateRequestBody;

    try {
      body = await ctx.req.json<GenerateRequestBody>();
    } catch (error) {
      logger.error("Invalid JSON payload for feature graph generation", {
        error: error instanceof Error ? error.message : String(error),
      });
      return ctx.json(
        { error: "Invalid JSON payload." },
        400 as ContentfulStatusCode,
      );
    }

    const workspaceAbsPath =
      typeof body.workspaceAbsPath === "string" ? body.workspaceAbsPath : undefined;
    const prompt =
      typeof body.prompt === "string" && body.prompt.trim()
        ? body.prompt.trim()
        : undefined;

    if (!workspaceAbsPath) {
      return ctx.json(
        { error: "workspaceAbsPath is required" },
        400 as ContentfulStatusCode,
      );
    }

    try {
      const resolvedWorkspaceAbsPath = resolveInsideRoot(workspaceAbsPath);
      const config: GraphConfig = {
        configurable: {
          workspacePath: resolvedWorkspaceAbsPath,
          ...(body.configurable ?? {}),
        },
      } as GraphConfig;

      const graphPath = `${resolvedWorkspaceAbsPath}/features/graph/graph.yaml`;
      const generated = await generateFeatureGraphForWorkspace({
        workspacePath: resolvedWorkspaceAbsPath,
        graphPath,
        config,
        prompt,
      });

      return ctx.json({
        featureGraph: generated.graphFile,
        activeFeatureIds: generated.activeFeatureIds,
      });
    } catch (error) {
      logger.error("Failed to generate feature graph", {
        error: error instanceof Error ? error.message : String(error),
      });
      return ctx.json(
        { error: "Failed to generate feature graph." },
        500 as ContentfulStatusCode,
      );
    }
  });

  app.post("/feature-graph/develop", async (ctx) => {
    const body = await ctx.req.json<DevelopRequestBody>().catch((error) => {
      logger.error("Invalid JSON payload for feature graph develop", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    const threadId = resolveThreadId(body);
    const featureId = resolveFeatureId(body);

    if (!threadId) {
      return ctx.json(
        { error: "thread_id is required" },
        400 as ContentfulStatusCode,
      );
    }

    if (!featureId) {
      return ctx.json(
        { error: "feature_id is required" },
        400 as ContentfulStatusCode,
      );
    }

    const client = createLangGraphClient({
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    const managerThreadState = await client.threads
      .getState<ManagerGraphState>(threadId)
      .catch((error) => {
        logger.error("Failed to load manager state for feature develop", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    if (!managerThreadState?.values) {
      return ctx.json(
        { error: "Manager state not found for thread" },
        404 as ContentfulStatusCode,
      );
    }

    // Load feature graph from file instead of state to avoid state serialization issues
    const workspacePath = managerThreadState.values.workspacePath;
    const featureGraph = await loadFeatureGraphFromFile(workspacePath);
    if (!featureGraph) {
      return ctx.json(
        { error: "Feature graph not available for thread. Please generate a feature graph first." },
        404 as ContentfulStatusCode,
      );
    }

    const { graph: reconciledGraph, dependencyMap } =
      reconcileFeatureGraphDependencies(featureGraph);

    const selectedFeature = reconciledGraph.getFeature(featureId);
    if (!selectedFeature) {
      return ctx.json(
        { error: "Feature not found in manager state" },
        404 as ContentfulStatusCode,
      );
    }

    const featureDependencies = getFeatureDependencies(
      reconciledGraph,
      featureId,
    );

    const existingPlannerSession = managerThreadState.values.plannerSession;
    const plannerThreadId =
      existingPlannerSession?.threadId ?? randomUUID();

    const plannerRunInput = buildPlannerRunInput({
      managerState: managerThreadState.values,
      featureId,
      selectedFeature,
      featureDependencies,
      dependencyMap,
      featureDescription: clarifyFeatureDescription(selectedFeature),
    });

    if (existingPlannerSession?.threadId && existingPlannerSession?.runId) {
      // Don't include featureGraph in state to avoid serialization issues - it's loaded from file
      const updatedManagerState: ManagerGraphUpdate = {
        plannerSession: {
          threadId: plannerThreadId,
          runId: existingPlannerSession.runId,
        },
        activeFeatureIds: [featureId],
      };

      // Exclude featureGraph from state update to prevent serialization issues
      const { featureGraph: _excludedGraph, ...existingManagerState } = managerThreadState.values;

      await client.threads
        .updateState<ManagerGraphState>(threadId, {
          values: {
            ...existingManagerState,
            ...updatedManagerState,
          },
          asNode: "start-planner",
        })
        .catch((error) => {
          logger.error("Failed to update manager state after feature develop", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      await client.threads
        .patchState(threadId, {
          configurable: {
            ...(managerThreadState.metadata?.configurable ?? {}),
            run_id: existingPlannerSession.runId,
            thread_id: plannerThreadId,
          },
        })
        .catch((error) => {
          logger.error("Failed to update manager metadata after feature develop", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return ctx.json({
        planner_thread_id: plannerThreadId,
        run_id: existingPlannerSession.runId,
      });
    }

    let run;
    const plannerRunConfigurable = {
      ...getCustomConfigurableFields({
        configurable: (managerThreadState.metadata?.configurable ?? {}) as
          | GraphConfig["configurable"]
          | undefined,
      } as GraphConfig),
      ...(managerThreadState.values.workspacePath
        ? { workspacePath: managerThreadState.values.workspacePath }
        : {}),
      ...(process.env.OPEN_SWE_LOCAL_MODE === "true"
        ? { [LOCAL_MODE_HEADER]: "true" }
        : {}),
      thread_id: plannerThreadId,
    } satisfies Record<string, unknown>;

    try {
      run = await client.runs.create(plannerThreadId, PLANNER_GRAPH_ID, {
        input: plannerRunInput,
        config: {
          recursion_limit: 400,
          configurable: plannerRunConfigurable,
        },
        ifNotExists: "create",
        streamResumable: true,
        streamMode: OPEN_SWE_STREAM_MODE as StreamMode[],
      });
    } catch (error) {
      logger.error("Failed to create planner run from feature develop", {
        error: error instanceof Error ? error.message : String(error),
      });
      return ctx.json(
        { error: "Failed to start planner run" },
        500 as ContentfulStatusCode,
      );
    }

    if (!run) {
      return ctx.json(
        { error: "Failed to start planner run" },
        500 as ContentfulStatusCode,
      );
    }

    const runIdentifiers = {
      run_id: run.run_id,
      thread_id: plannerThreadId,
    };

    // Don't include featureGraph in state to avoid serialization issues - it's loaded from file
    const updatedManagerState: ManagerGraphUpdate = {
      plannerSession: {
        threadId: plannerThreadId,
        runId: run.run_id,
      },
      activeFeatureIds: [featureId],
    };

    // Exclude featureGraph from state update to prevent serialization issues
    const { featureGraph: _excludedGraph, ...restManagerState } = managerThreadState.values;

    await client.threads
      .updateState<ManagerGraphState>(threadId, {
        values: {
          ...restManagerState,
          ...updatedManagerState,
        },
        asNode: "start-planner",
      })
      .catch((error) => {
        logger.error("Failed to update manager state after feature develop", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    await client.threads
      .patchState(threadId, {
        configurable: {
          ...(managerThreadState.metadata?.configurable ?? {}),
          ...runIdentifiers,
        },
      })
      .catch((error) => {
        logger.error("Failed to update manager metadata after feature develop", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return ctx.json({
      planner_thread_id: plannerThreadId,
      run_id: run.run_id,
    });
  });

  /**
   * Load feature graph from file for a thread.
   * This endpoint doesn't modify state, avoiding "thread busy" errors.
   */
  app.post("/feature-graph/load", async (ctx) => {
    const body = await ctx.req.json<{ thread_id?: unknown; threadId?: unknown }>().catch((error) => {
      logger.error("Invalid JSON payload for feature graph load", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    const threadId = resolveThreadId(body as DevelopRequestBody | null);

    if (!threadId) {
      return ctx.json(
        { error: "thread_id is required" },
        400 as ContentfulStatusCode,
      );
    }

    const client = createLangGraphClient({
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    // Retry getState with exponential backoff if thread is busy
    const maxRetries = 3;
    let lastError: unknown = null;
    let managerThreadState = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        managerThreadState = await client.threads.getState<ManagerGraphState>(threadId);
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
        logger.error("Failed to load manager state for feature graph load", {
          error: error instanceof Error ? error.message : String(error),
          status,
        });
        break;
      }
    }

    if (!managerThreadState?.values) {
      const status = (lastError as { status?: number })?.status ?? 404;
      const message = status === 409
        ? "Thread is busy, please try again later"
        : "Manager state not found for thread";
      return ctx.json(
        { error: message },
        status as ContentfulStatusCode,
      );
    }

    const workspacePath = managerThreadState.values.workspacePath;
    const featureGraph = await loadFeatureGraphFromFile(workspacePath);

    if (!featureGraph) {
      return ctx.json(
        { error: "Feature graph not available for thread. Please generate a feature graph first." },
        404 as ContentfulStatusCode,
      );
    }

    const serialized = featureGraph.toJSON();

    return ctx.json({
      featureGraph: {
        version: serialized.version,
        nodes: serialized.nodes,
        edges: serialized.edges,
        artifacts: serialized.artifacts,
      },
      activeFeatureIds: managerThreadState.values.activeFeatureIds ?? [],
      featureProposals: managerThreadState.values.featureProposals ?? null,
    });
  });

  app.post("/feature-graph/proposal", async (ctx) => {
    const body = await ctx.req.json<ProposalActionRequestBody>().catch((error) => {
      logger.error("Invalid JSON payload for feature proposal action", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    const threadId = resolveThreadId(body);
    const featureId = resolveFeatureId(body);
    const proposalId = resolveProposalId(body);
    const action = resolveProposalAction(body);
    const rationale = resolveRationale(body) ?? undefined;

    if (!threadId) {
      return ctx.json(
        { error: "thread_id is required" },
        400 as ContentfulStatusCode,
      );
    }

    if (!featureId && !proposalId) {
      return ctx.json(
        { error: "feature_id or proposal_id is required" },
        400 as ContentfulStatusCode,
      );
    }

    if (!action) {
      return ctx.json(
        { error: "action must be approve, reject, or info" },
        400 as ContentfulStatusCode,
      );
    }

    const client = createLangGraphClient({
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    const managerThreadState = await client.threads
      .getState<ManagerGraphState>(threadId)
      .catch((error) => {
        logger.error("Failed to load manager state for feature proposal", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    if (!managerThreadState?.values) {
      return ctx.json(
        { error: "Manager state not found for thread" },
        404 as ContentfulStatusCode,
      );
    }

    const managerState = managerThreadState.values;
    const proposalState = ensureProposalState(managerState.featureProposals);

    // Load feature graph from file instead of state to avoid state serialization issues
    const featureGraph = await loadFeatureGraphFromFile(managerState.workspacePath);

    const resolvedFeatureId = featureId ?? findFeatureIdForProposal(
      proposalState,
      proposalId,
    );

    if (!resolvedFeatureId) {
      return ctx.json(
        { error: "Unable to resolve feature for proposal action" },
        400 as ContentfulStatusCode,
      );
    }

    if (!featureGraph) {
      return ctx.json(
        { error: "Feature graph not available for thread. Please generate a feature graph first." },
        404 as ContentfulStatusCode,
      );
    }

    const selectedFeature = featureGraph.getFeature(resolvedFeatureId);
    if (!selectedFeature) {
      return ctx.json(
        { error: "Feature not found in manager state" },
        404 as ContentfulStatusCode,
      );
    }

    let updatedGraph = featureGraph;
    let updatedProposals = proposalState;
    let message: string | null = null;

    try {
      const timestamp = new Date().toISOString();
      const matchingProposal = proposalState.proposals.find(
        (proposal) =>
          proposal.proposalId === proposalId ||
          proposal.featureId === resolvedFeatureId,
      );

      switch (action) {
        case "approve": {
          const proposal: FeatureProposal = {
            proposalId: matchingProposal?.proposalId ?? randomUUID(),
            featureId: resolvedFeatureId,
            summary:
              matchingProposal?.summary ??
              `Approved update for ${resolvedFeatureId}`,
            status: "approved",
            rationale,
            updatedAt: timestamp,
          };

          updatedProposals = upsertProposal(updatedProposals, proposal);
          updatedGraph = applyFeatureStatus(updatedGraph, resolvedFeatureId, "active");
          await persistFeatureGraph(updatedGraph, managerState.workspacePath);
          message = `Marked ${resolvedFeatureId} as approved`;
          break;
        }
        case "reject": {
          const proposal: FeatureProposal = {
            proposalId: matchingProposal?.proposalId ?? randomUUID(),
            featureId: resolvedFeatureId,
            summary:
              matchingProposal?.summary ??
              `Rejected update for ${resolvedFeatureId}`,
            status: "rejected",
            rationale,
            updatedAt: timestamp,
          };

          updatedProposals = upsertProposal(updatedProposals, proposal);
          updatedGraph = applyFeatureStatus(
            updatedGraph,
            resolvedFeatureId,
            "rejected",
          );
          await persistFeatureGraph(updatedGraph, managerState.workspacePath);
          message = `Recorded rejection for ${resolvedFeatureId}`;
          break;
        }
        case "info": {
          const proposal: FeatureProposal = {
            proposalId: matchingProposal?.proposalId ?? randomUUID(),
            featureId: resolvedFeatureId,
            summary:
              matchingProposal?.summary ??
              `Requested more information for ${resolvedFeatureId}`,
            status: "proposed",
            rationale,
            updatedAt: timestamp,
          };

          updatedProposals = upsertProposal(updatedProposals, proposal);
          message = `Requested more information for ${resolvedFeatureId}`;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      logger.error("Failed to process feature proposal action", {
        action,
        featureId: resolvedFeatureId,
        error: error instanceof Error ? error.message : String(error),
      });
      return ctx.json(
        { error: "Failed to process feature proposal action" },
        500 as ContentfulStatusCode,
      );
    }

    const activeFeatureIds =
      action === "approve"
        ? addActiveFeatureId(managerState.activeFeatureIds, resolvedFeatureId)
        : normalizeFeatureIds(managerState.activeFeatureIds);

    // Don't include featureGraph in state to avoid serialization issues - it's persisted to file
    const updatedState: ManagerGraphUpdate = {
      featureProposals: updatedProposals,
      activeFeatureIds,
    };

    // Exclude featureGraph from state update to prevent serialization issues
    const { featureGraph: _excludedGraph, ...restManagerState } = managerState;

    await client.threads.updateState<ManagerGraphState>(threadId, {
      values: { ...restManagerState, ...updatedState },
      asNode: "feature-graph-agent",
    });

    return ctx.json({
      featureGraph: updatedGraph.toJSON(),
      activeFeatureIds,
      featureProposals: updatedProposals.proposals,
      activeProposalId: updatedProposals.activeProposalId,
      message,
    });
  });
}

function resolveThreadId(
  body: DevelopRequestBody | ProposalActionRequestBody | null,
): string | null {
  const candidate = body?.thread_id ?? body?.threadId;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function resolveFeatureId(
  body: DevelopRequestBody | ProposalActionRequestBody | null,
): string | null {
  const candidate = body?.feature_id ?? body?.featureId;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function resolveProposalId(body: ProposalActionRequestBody | null): string | null {
  const candidate = body?.proposal_id ?? body?.proposalId;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

type ProposalAction = "approve" | "reject" | "info";

function resolveProposalAction(
  body: ProposalActionRequestBody | null,
): ProposalAction | null {
  if (body?.action === "approve" || body?.action === "reject") {
    return body.action;
  }

  if (body?.action === "info") {
    return "info";
  }

  return null;
}

function resolveRationale(body: ProposalActionRequestBody | null): string | null {
  const candidate = body?.rationale;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function ensureProposalState(
  state: FeatureProposalState | undefined,
): FeatureProposalState {
  return state ?? { proposals: [] };
}

function findFeatureIdForProposal(
  state: FeatureProposalState,
  proposalId: string | null,
): string | null {
  if (!proposalId) return null;
  const match = state.proposals.find(
    (proposal) => proposal.proposalId === proposalId,
  );
  return match?.featureId ?? null;
}

function upsertProposal(
  state: FeatureProposalState,
  proposal: FeatureProposal,
): FeatureProposalState {
  const proposals = state.proposals.filter(
    (existing) => existing.proposalId !== proposal.proposalId,
  );
  proposals.push(proposal);

  return {
    proposals,
    activeProposalId: proposal.proposalId,
  };
}

function addActiveFeatureId(
  existing: string[] | undefined,
  featureId: string,
): string[] {
  const normalizedExisting = normalizeFeatureIds(existing);
  const trimmedId = featureId.trim();
  if (!trimmedId) return normalizedExisting;

  const key = trimmedId.toLowerCase();
  if (normalizedExisting.some((entry) => entry.toLowerCase() === key)) {
    return normalizedExisting;
  }

  return [trimmedId, ...normalizedExisting];
}

function normalizeFeatureIds(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function getFeatureDependencies(
  graph: FeatureGraph,
  featureId: string,
): FeatureNode[] {
  const seen = new Set<string>([featureId]);
  const dependencies: FeatureNode[] = [];

  for (const neighbor of graph.getNeighbors(featureId, "both")) {
    if (seen.has(neighbor.id)) continue;
    seen.add(neighbor.id);
    dependencies.push(neighbor);
  }

  return dependencies;
}

function buildPlannerRunInput({
  managerState,
  featureId,
  selectedFeature,
  featureDependencies,
  dependencyMap,
  featureDescription,
}: {
  managerState: ManagerGraphState;
  featureId: string;
  selectedFeature: FeatureNode;
  featureDependencies: FeatureNode[];
  dependencyMap: Record<string, string[]>;
  featureDescription: string;
}): PlannerGraphUpdate {
  return {
    issueId: managerState.issueId,
    targetRepository: managerState.targetRepository,
    taskPlan: managerState.taskPlan,
    branchName: managerState.branchName,
    autoAcceptPlan: managerState.autoAcceptPlan,
    workspacePath: managerState.workspacePath,
    activeFeatureIds: [featureId],
    features: [selectedFeature, ...featureDependencies],
    featureDependencies,
    featureDependencyMap: dependencyMap,
    featureDescription,
    programmerSession: managerState.programmerSession,
    messages: managerState.messages,
  } satisfies PlannerGraphUpdate;
}
