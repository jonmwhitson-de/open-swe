import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { Client, StreamMode } from "@langchain/langgraph-sdk";
import {
  LOCAL_MODE_HEADER,
  OPEN_SWE_STREAM_MODE,
  PLANNER_GRAPH_ID,
} from "@openswe/shared/constants";
import {
  clarifyFeatureDescription,
  reconcileFeatureGraph,
  type FeatureGraph,
  type FeatureNode,
} from "@openswe/shared/feature-graph";
import type {
  ManagerGraphState,
  ManagerGraphUpdate,
} from "@openswe/shared/open-swe/manager/types";
import type { PlannerGraphUpdate } from "@openswe/shared/open-swe/planner/types";
import type { GraphConfig } from "@openswe/shared/open-swe/types";
import { getCustomConfigurableFields } from "@openswe/shared/open-swe/utils/config";
import { coerceFeatureGraph } from "@/lib/coerce-feature-graph";

/**
 * Load feature graph from the backend by calling the /feature-graph/load endpoint.
 * This loads from file instead of state to avoid state serialization issues.
 */
async function loadFeatureGraphFromBackend(
  threadId: string,
): Promise<{ graph: FeatureGraph | null; error?: string }> {
  const backendUrl =
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.OPEN_SWE_LOCAL_MODE === "true") {
    headers[LOCAL_MODE_HEADER] = "true";
  }

  try {
    const response = await fetch(`${backendUrl}/feature-graph/load`, {
      method: "POST",
      headers,
      body: JSON.stringify({ thread_id: threadId }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message =
        (payload && typeof payload.error === "string" ? payload.error : null) ??
        `Failed to load feature graph (status ${response.status})`;
      return { graph: null, error: message };
    }

    const payload = await response.json();
    const graph = coerceFeatureGraph(payload.featureGraph);
    return { graph };
  } catch (error) {
    return {
      graph: null,
      error: error instanceof Error ? error.message : "Failed to load feature graph",
    };
  }
}

function resolveApiUrl(): string {
  return (
    process.env.LANGGRAPH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:2024"
  );
}

function resolveThreadId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return null;
}

function getFeatureDependencies(graph: FeatureGraph, featureId: string): FeatureNode[] {
  const seen = new Set<string>([featureId]);
  const dependencies: FeatureNode[] = [];

  for (const neighbor of graph.getNeighbors(featureId, "both")) {
    if (seen.has(neighbor.id)) continue;
    seen.add(neighbor.id);
    dependencies.push(neighbor);
  }

  return dependencies;
}

type PlainHumanMessage = {
  type: "human";
  content: string;
  id?: string;
};

function buildFeatureImplementationMessage(
  feature: FeatureNode,
  dependencies: FeatureNode[],
): PlainHumanMessage {
  const parts: string[] = [];

  parts.push(`Implement the following feature:\n`);
  parts.push(`**Feature: ${feature.name}**`);
  parts.push(`ID: ${feature.id}`);
  parts.push(`Description: ${feature.description}`);

  if (feature.status) {
    parts.push(`Status: ${feature.status}`);
  }

  if (feature.group) {
    parts.push(`Group: ${feature.group}`);
  }

  if (feature.artifacts) {
    const artifactsList = Array.isArray(feature.artifacts)
      ? feature.artifacts
      : Object.values(feature.artifacts);
    if (artifactsList.length > 0) {
      parts.push(`\nRelated artifacts:`);
      for (const artifact of artifactsList) {
        if (typeof artifact === "string") {
          parts.push(`- ${artifact}`);
        } else if (artifact.path) {
          parts.push(`- ${artifact.path}${artifact.description ? `: ${artifact.description}` : ""}`);
        } else if (artifact.name) {
          parts.push(`- ${artifact.name}${artifact.description ? `: ${artifact.description}` : ""}`);
        }
      }
    }
  }

  if (dependencies.length > 0) {
    parts.push(`\nRelated features to consider:`);
    for (const dep of dependencies) {
      parts.push(`- ${dep.name}: ${dep.description}`);
    }
  }

  return {
    type: "human",
    content: parts.join("\n"),
    id: randomUUID(),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const apiUrl = resolveApiUrl();
  let threadId: string | null = null;
  let featureId: string = "";

  try {
    const body = await request.json();
    threadId =
      resolveThreadId(body?.thread_id) ?? resolveThreadId(body?.threadId);
    featureId =
      typeof body?.feature_id === "string"
        ? body.feature_id.trim()
        : typeof body?.featureId === "string"
          ? body.featureId.trim()
          : "";

    if (!threadId) {
      return NextResponse.json(
        { error: "thread_id is required" },
        { status: 400 },
      );
    }

    if (!featureId) {
      return NextResponse.json(
        { error: "feature_id is required" },
        { status: 400 },
      );
    }

    const client = new Client({
      apiUrl,
      defaultHeaders:
        process.env.OPEN_SWE_LOCAL_MODE === "true"
          ? { [LOCAL_MODE_HEADER]: "true" }
          : undefined,
    });

    // Fetch manager thread state
    let managerThreadState;
    try {
      managerThreadState = await client.threads.getState<ManagerGraphState>(threadId);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      console.error("[develop] Failed to fetch manager state:", { threadId, status, error: err });
      return NextResponse.json(
        { error: `Failed to fetch manager state: ${status === 404 ? "Thread not found" : "LangGraph API error"}` },
        { status: status ?? 500 },
      );
    }

    if (!managerThreadState?.values) {
      return NextResponse.json(
        { error: "Manager state not found for thread" },
        { status: 404 },
      );
    }

    const managerState = managerThreadState.values;

    // Load feature graph from backend (file-based) instead of state
    // to avoid state serialization issues
    const { graph: featureGraph, error: graphError } = await loadFeatureGraphFromBackend(threadId);
    if (!featureGraph) {
      return NextResponse.json(
        { error: graphError ?? "Feature graph not available for thread. Generate a feature graph first." },
        { status: 404 },
      );
    }

    // Reconcile feature graph
    let reconciledGraph: FeatureGraph;
    let dependencyMap: Record<string, string[]>;
    try {
      const result = reconcileFeatureGraph(featureGraph);
      reconciledGraph = result.graph;
      dependencyMap = result.dependencyMap;
    } catch (err) {
      console.error("[develop] Failed to reconcile feature graph:", err);
      return NextResponse.json(
        { error: "Failed to process feature graph" },
        { status: 500 },
      );
    }

    const existingPlannerSession = managerState.plannerSession;
    // Always create a NEW planner thread to avoid "thread busy" errors
    const plannerThreadId = randomUUID();

    const selectedFeature = reconciledGraph.getFeature(featureId);

    if (!selectedFeature) {
      return NextResponse.json(
        { error: `Feature "${featureId}" not found in feature graph` },
        { status: 404 },
      );
    }

    const featureDependencies = getFeatureDependencies(
      reconciledGraph,
      featureId,
    );

    // Create an initial message that describes the feature to implement
    const featureMessage = buildFeatureImplementationMessage(
      selectedFeature,
      featureDependencies,
    );

    const plannerRunInput: PlannerGraphUpdate = {
      issueId: managerState.issueId,
      targetRepository: managerState.targetRepository,
      taskPlan: managerState.taskPlan,
      branchName: managerState.branchName,
      autoAcceptPlan: managerState.autoAcceptPlan,
      workspacePath: managerState.workspacePath,
      activeFeatureIds: [featureId],
      features: [selectedFeature, ...(featureDependencies ?? [])],
      featureDependencies: featureDependencies ?? [],
      featureDependencyMap: dependencyMap,
      featureDescription: clarifyFeatureDescription(selectedFeature),
      programmerSession: managerState.programmerSession,
      // Pass a single message describing the feature to implement
      // instead of the full chat history
      messages: [featureMessage] as any, // Type coercion needed for plain message format
    };

    const plannerRunConfigurableBase = {
      ...getCustomConfigurableFields({
        configurable: (managerThreadState.metadata?.configurable ?? {}) as
          | GraphConfig["configurable"]
          | undefined,
      } as GraphConfig),
      ...(managerState.workspacePath
        ? { workspacePath: managerState.workspacePath }
        : {}),
      ...(process.env.OPEN_SWE_LOCAL_MODE === "true"
        ? { [LOCAL_MODE_HEADER]: "true" }
        : {}),
      thread_id: plannerThreadId,
    } satisfies Record<string, unknown>;

    // Create a new planner run (always create new thread to avoid "thread busy")
    let run;
    try {
      run = await client.runs.create(plannerThreadId, PLANNER_GRAPH_ID, {
        input: plannerRunInput,
        config: {
          recursion_limit: 400,
          configurable: plannerRunConfigurableBase,
        },
        ifNotExists: "create",
        streamResumable: true,
        streamMode: OPEN_SWE_STREAM_MODE as StreamMode[],
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[develop] Failed to create planner run:", { plannerThreadId, error: err });
      return NextResponse.json(
        { error: `Failed to create planner run: ${errMsg}` },
        { status: 500 },
      );
    }

    const runIdentifiers = {
      run_id: run.run_id,
      thread_id: plannerThreadId,
    } satisfies Record<string, unknown>;

    const plannerRunConfigurable = {
      ...plannerRunConfigurableBase,
      ...runIdentifiers,
    } satisfies Record<string, unknown>;

    // Don't include featureGraph in state - it's persisted to file and loaded when needed.
    // This prevents state from growing too large.
    const updatedManagerState: ManagerGraphUpdate = {
      plannerSession: {
        threadId: plannerThreadId,
        runId: run.run_id,
      },
      activeFeatureIds: [featureId],
    };

    // Update manager thread state
    try {
      await client.threads.updateState<ManagerGraphState>(threadId, {
        values: {
          ...managerState,
          ...updatedManagerState,
        },
        asNode: "start-planner",
      });
    } catch (err) {
      console.error("[develop] Failed to update manager state:", err);
      // Continue anyway - the planner run was created successfully
    }

    try {
      await client.threads.patchState(threadId, {
        configurable: {
          ...(managerThreadState.metadata?.configurable ?? {}),
          ...runIdentifiers,
        },
      });
    } catch (err) {
      console.error("[develop] Failed to patch manager configurable:", err);
      // Continue anyway
    }

    try {
      await client.threads.patchState(plannerThreadId, {
        configurable: plannerRunConfigurable,
      });
    } catch (err) {
      console.error("[develop] Failed to patch planner configurable:", err);
      // Continue anyway
    }

    return NextResponse.json({
      planner_thread_id: plannerThreadId,
      run_id: run.run_id,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start feature run";
    console.error("[develop] Unexpected error:", { threadId, featureId, error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
