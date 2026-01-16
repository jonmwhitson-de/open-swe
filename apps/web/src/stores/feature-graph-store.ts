import { create } from "zustand";

import { FeatureGraph } from "@openswe/shared/feature-graph/graph";
import { testsForFeature } from "@openswe/shared/feature-graph/mappings";
import type {
  ArtifactCollection,
  ArtifactRef,
  FeatureNode,
} from "@openswe/shared/feature-graph/types";
import type { FeatureProposal } from "@openswe/shared/open-swe/manager/types";

import {
  FeatureGraphFetchResult,
  mapFeatureProposalState,
  mapFeatureGraphPayload,
  normalizeFeatureIds,
} from "@/lib/feature-graph-payload";
import { coerceFeatureGraph } from "@/lib/coerce-feature-graph";
import {
  fetchFeatureGraph,
  performFeatureProposalAction,
  type FeatureProposalAction,
  requestFeatureGraphGeneration,
  startFeatureDevelopmentRun,
  type DependencyValidationError,
} from "@/services/feature-graph.service";

export type FeatureResource = {
  id: string;
  label: string;
  secondaryLabel?: string;
  description?: string;
  href?: string;
};

export type FeatureRunStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "error";

export type AutoDevelopStatus =
  | "idle"
  | "loading" // Loading development order
  | "running" // Auto-developing features
  | "paused" // Paused by user
  | "completed" // All features developed
  | "error";

export interface AutoDevelopState {
  status: AutoDevelopStatus;
  /** Features queued for development, in order */
  queue: string[];
  /** Currently developing feature ID */
  currentFeatureId: string | null;
  /** Index in the queue */
  currentIndex: number;
  /** Total features to develop */
  totalFeatures: number;
  /** Number of features completed in this auto-develop session */
  completedInSession: number;
  /** Error message if status is 'error' */
  error: string | null;
}

export type FeatureRunState = {
  threadId: string | null;
  runId: string | null;
  status: FeatureRunStatus;
  error?: string | null;
  updatedAt: number;
};

type ProposalActionState = {
  status: "idle" | "pending" | "error";
  error?: string | null;
  message?: string | null;
  updatedAt: number;
};

interface FeatureGraphStoreState {
  threadId: string | null;
  /** Workspace path for loading the feature graph from file */
  workspacePath: string | null;
  /** Optional design thread ID for isolated feature design */
  designThreadId: string | null;
  graph: FeatureGraph | null;
  features: FeatureNode[];
  featuresById: Record<string, FeatureNode>;
  activeFeatureIds: string[];
  proposals: FeatureProposal[];
  activeProposalId: string | null;
  proposalActions: Record<string, ProposalActionState>;
  selectedFeatureId: string | null;
  testsByFeatureId: Record<string, FeatureResource[]>;
  artifactsByFeatureId: Record<string, FeatureResource[]>;
  featureRuns: Record<string, FeatureRunState>;
  isLoading: boolean;
  isGeneratingGraph: boolean;
  error: string | null;
  /** Dependency validation error - shown when trying to develop a feature with incomplete dependencies */
  dependencyError: DependencyValidationError | null;
  /** Auto-develop state - tracks automated sequential feature development */
  autoDevelop: AutoDevelopState;
  /**
   * Fetch feature graph using workspace path directly.
   * No thread state access needed - eliminates 409 "thread busy" errors.
   */
  fetchGraphForWorkspace: (
    workspacePath: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  /** @deprecated Use fetchGraphForWorkspace instead */
  fetchGraphForThread: (
    threadId: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  generateGraph: (workspacePath: string, prompt: string) => Promise<void>;
  requestGraphGeneration: (threadId: string) => Promise<void>;
  startFeatureDevelopment: (featureId: string, options?: { force?: boolean }) => Promise<void>;
  /** Clear the current dependency error */
  clearDependencyError: () => void;
  /**
   * Start auto-developing all features in dependency order.
   * Will skip already completed features.
   */
  startAutoDevelop: (featureIds?: string[]) => Promise<void>;
  /** Pause auto-development (can be resumed) */
  pauseAutoDevelop: () => void;
  /** Resume auto-development from where it was paused */
  resumeAutoDevelop: () => Promise<void>;
  /** Stop auto-development completely */
  stopAutoDevelop: () => void;
  /** Called when a feature completes - triggers next feature in queue if auto-developing */
  onFeatureCompleted: (featureId: string) => Promise<void>;
  /**
   * Start development via an isolated design thread.
   * This creates a new planner thread to avoid "thread busy" errors.
   */
  startDesignDevelopment: (featureIds: string[], designThreadId: string) => Promise<{
    plannerThreadId: string;
    runId: string;
  }>;
  respondToProposal: (
    proposalId: string,
    action: FeatureProposalAction,
    options?: { rationale?: string },
  ) => Promise<string | void>;
  setFeatureRunStatus: (
    featureId: string,
    status: FeatureRunStatus,
    options?: {
      runId?: string | null;
      threadId?: string | null;
      error?: string;
    },
  ) => void;
  /**
   * Mark a feature as completed in the graph.
   * Updates the feature status to "completed" and removes from activeFeatureIds.
   */
  completeFeature: (featureId: string) => Promise<void>;
  /**
   * Delete a feature from the graph.
   */
  deleteFeature: (featureId: string) => Promise<void>;
  selectFeature: (featureId: string | null) => void;
  setActiveFeatureIds: (featureIds?: string[] | null) => void;
  setDesignThreadId: (designThreadId: string | null) => void;
  /** Set the manager thread ID for operations that require it */
  setThreadId: (threadId: string | null) => void;
  clear: () => void;
}

const INITIAL_AUTO_DEVELOP_STATE: AutoDevelopState = {
  status: "idle",
  queue: [],
  currentFeatureId: null,
  currentIndex: 0,
  totalFeatures: 0,
  completedInSession: 0,
  error: null,
};

const INITIAL_STATE: Omit<
    FeatureGraphStoreState,
    | "fetchGraphForWorkspace"
    | "fetchGraphForThread"
    | "generateGraph"
    | "requestGraphGeneration"
    | "startFeatureDevelopment"
    | "clearDependencyError"
    | "startAutoDevelop"
    | "pauseAutoDevelop"
    | "resumeAutoDevelop"
    | "stopAutoDevelop"
    | "onFeatureCompleted"
    | "startDesignDevelopment"
    | "respondToProposal"
    | "setFeatureRunStatus"
    | "completeFeature"
    | "deleteFeature"
    | "selectFeature"
    | "setActiveFeatureIds"
    | "setDesignThreadId"
    | "setThreadId"
    | "clear"
  > = {
  threadId: null,
  workspacePath: null,
  designThreadId: null,
  graph: null,
  features: [],
  featuresById: {},
  activeFeatureIds: [],
  proposals: [],
  activeProposalId: null,
  proposalActions: {},
  selectedFeatureId: null,
  testsByFeatureId: {},
  artifactsByFeatureId: {},
  featureRuns: {},
  isLoading: false,
  isGeneratingGraph: false,
  error: null,
  dependencyError: null,
  autoDevelop: INITIAL_AUTO_DEVELOP_STATE,
};

export const useFeatureGraphStore = create<FeatureGraphStoreState>(
  (set, get) => ({
    ...INITIAL_STATE,
    /**
     * Fetch feature graph using workspace path directly.
     * No thread state access needed - eliminates 409 "thread busy" errors.
     */
    async fetchGraphForWorkspace(workspacePath, options) {
      const { workspacePath: currentPath, isLoading, graph } = get();
      const shouldSkip =
        !workspacePath ||
        (!options?.force &&
          workspacePath === currentPath &&
          (graph !== null || isLoading));

      if (shouldSkip) return;

      set((state) => ({
        ...INITIAL_STATE,
        threadId: state.threadId, // Preserve threadId for other operations
        workspacePath,
        isLoading: true,
        isGeneratingGraph: state.isGeneratingGraph,
      }));

      try {
        const result = await fetchFeatureGraph(workspacePath);
        set((state) => mapFetchResultToState(state, result));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load feature graph";
        set((state) => ({
          ...state,
          workspacePath,
          isLoading: false,
          isGeneratingGraph: false,
          error: message,
          graph: null,
          features: [],
          featuresById: {},
          testsByFeatureId: {},
          artifactsByFeatureId: {},
          activeFeatureIds: [],
          proposals: [],
          activeProposalId: null,
          proposalActions: {},
          selectedFeatureId: null,
        }));
      }
    },
    /**
     * @deprecated Use fetchGraphForWorkspace instead.
     * This method is kept for backwards compatibility but logs a warning.
     */
    async fetchGraphForThread(threadId, options) {
      console.warn(
        "[FeatureGraphStore] fetchGraphForThread is deprecated. Use fetchGraphForWorkspace with workspace path instead.",
      );
      // Store the threadId for other operations that still need it
      set({ threadId });
      // Cannot fetch without workspace path - this is a no-op now
    },
    async generateGraph(workspacePath, prompt) {
      const { isGeneratingGraph } = get();
      if (!workspacePath || isGeneratingGraph) return;

      set((state) => ({
        ...state,
        workspacePath,
        isGeneratingGraph: true,
        isLoading: true,
        error: null,
      }));

      try {
        const response = await fetch("/api/feature-graph/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspace_path: workspacePath, prompt }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          // API returns errors in 'error' field, not 'message'
          const message =
            (payload && typeof payload.error === "string"
              ? payload.error
              : null) ??
            (payload && typeof payload.message === "string"
              ? payload.message
              : null) ??
            "Failed to generate feature graph";
          throw new Error(message);
        }

        const payload = await response.json();
        const result = mapFeatureGraphPayload(payload);

        set((state) =>
          mapFetchResultToState(
            { ...state, workspacePath, isGeneratingGraph: false },
            result,
          ),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate feature graph";
        set((state) => ({
          ...state,
          workspacePath,
          isGeneratingGraph: false,
          isLoading: false,
          error: message,
        }));
      }
    },
    async requestGraphGeneration(threadId) {
      const { isGeneratingGraph, workspacePath } = get();
      if (!threadId || isGeneratingGraph) return;

      set({ isGeneratingGraph: true, threadId, error: null });

      try {
        await requestFeatureGraphGeneration(threadId);
        // After generation, reload the graph using workspace path if available
        if (workspacePath) {
          await get().fetchGraphForWorkspace(workspacePath, { force: true });
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to request feature graph generation";
        set({
          threadId,
          isGeneratingGraph: false,
          error: message,
        });
      }
    },
    async startFeatureDevelopment(featureId, options) {
      const { threadId, featureRuns, featuresById } = get();
      if (!threadId || !featureId || !featuresById[featureId]) return;

      const existingRun = featureRuns[featureId];
      if (
        existingRun?.status === "running" ||
        existingRun?.status === "starting"
      ) {
        set({ selectedFeatureId: featureId });
        return;
      }

      const nextRunState: FeatureRunState = {
        threadId: null,
        runId: null,
        status: "starting",
        error: null,
        updatedAt: Date.now(),
      };

      set((state) => ({
        ...state,
        selectedFeatureId: featureId,
        dependencyError: null, // Clear any previous dependency error
        featureRuns: {
          ...state.featureRuns,
          [featureId]: nextRunState,
        },
      }));

      try {
        const result = await startFeatureDevelopmentRun(
          threadId,
          featureId,
          { force: options?.force },
        );

        // Handle dependency validation error
        if (!result.success) {
          set((state) => ({
            ...state,
            selectedFeatureId: featureId,
            dependencyError: result.dependencyError,
            featureRuns: {
              ...state.featureRuns,
              [featureId]: {
                threadId: null,
                runId: null,
                status: "idle", // Reset to idle - not an error, just blocked
                error: null,
                updatedAt: Date.now(),
              },
            },
          }));
          return; // Don't throw - let UI handle the dependency dialog
        }

        const { plannerThreadId, runId } = result.response;

        set((state) => {
          // Add featureId to activeFeatureIds if not already present
          const newActiveFeatureIds = state.activeFeatureIds.includes(featureId)
            ? state.activeFeatureIds
            : [...state.activeFeatureIds, featureId];

          return {
            ...state,
            selectedFeatureId: featureId,
            dependencyError: null,
            activeFeatureIds: newActiveFeatureIds,
            featureRuns: {
              ...state.featureRuns,
              [featureId]: {
                threadId: plannerThreadId,
                runId,
                status: "running",
                error: null,
                updatedAt: Date.now(),
              },
            },
          };
        });
      } catch (error) {
        const baseMessage =
          error instanceof Error
            ? error.message
            : "Failed to start feature development";
        const normalized = baseMessage.toLowerCase();
        const isThreadBusy =
          normalized.includes("busy") || normalized.includes("running");

        const message = isThreadBusy
          ? `${baseMessage}. Open the Planner tab to finish or cancel the current design run before retrying.`
          : baseMessage;

        set((state) => ({
          ...state,
          selectedFeatureId: featureId,
          featureRuns: {
            ...state.featureRuns,
            [featureId]: {
              threadId: null,
              runId: null,
              status: "error",
              error: message,
              updatedAt: Date.now(),
            },
          },
        }));

        throw new Error(message);
      }
    },
    clearDependencyError() {
      set({ dependencyError: null });
    },
    async startAutoDevelop(featureIds) {
      const { workspacePath, threadId, autoDevelop } = get();

      if (!workspacePath || !threadId) {
        console.error("Cannot start auto-develop: missing workspacePath or threadId");
        return;
      }

      if (autoDevelop.status === "running" || autoDevelop.status === "loading") {
        console.warn("Auto-develop already in progress");
        return;
      }

      set({
        autoDevelop: {
          ...INITIAL_AUTO_DEVELOP_STATE,
          status: "loading",
        },
      });

      try {
        // Fetch optimal development order from API
        const response = await fetch("/api/feature-graph/development-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_path: workspacePath,
            feature_ids: featureIds,
            include_completed: false, // Skip already completed features
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to get development order");
        }

        const data = await response.json();
        const queue = (data.development_order ?? []).map(
          (f: { id: string }) => f.id,
        );

        if (queue.length === 0) {
          set({
            autoDevelop: {
              ...INITIAL_AUTO_DEVELOP_STATE,
              status: "completed",
              totalFeatures: 0,
            },
          });
          return;
        }

        // Start with the first feature
        const firstFeatureId = queue[0];

        set({
          autoDevelop: {
            status: "running",
            queue,
            currentFeatureId: firstFeatureId,
            currentIndex: 0,
            totalFeatures: queue.length,
            completedInSession: 0,
            error: null,
          },
        });

        // Start developing the first feature
        await get().startFeatureDevelopment(firstFeatureId, { force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start auto-develop";
        set({
          autoDevelop: {
            ...INITIAL_AUTO_DEVELOP_STATE,
            status: "error",
            error: message,
          },
        });
      }
    },
    pauseAutoDevelop() {
      const { autoDevelop } = get();
      if (autoDevelop.status !== "running") return;

      set({
        autoDevelop: {
          ...autoDevelop,
          status: "paused",
        },
      });
    },
    async resumeAutoDevelop() {
      const { autoDevelop } = get();
      if (autoDevelop.status !== "paused") return;

      const currentFeatureId = autoDevelop.currentFeatureId;
      if (!currentFeatureId) {
        // No current feature, try to start next
        await get().onFeatureCompleted("");
        return;
      }

      set({
        autoDevelop: {
          ...autoDevelop,
          status: "running",
        },
      });

      // Check if current feature is still running
      const { featureRuns } = get();
      const currentRun = featureRuns[currentFeatureId];

      if (!currentRun || currentRun.status === "idle" || currentRun.status === "error") {
        // Restart the current feature
        await get().startFeatureDevelopment(currentFeatureId, { force: true });
      }
      // If it's already running, just let it continue
    },
    stopAutoDevelop() {
      set({
        autoDevelop: INITIAL_AUTO_DEVELOP_STATE,
      });
    },
    async onFeatureCompleted(featureId) {
      const { autoDevelop, threadId } = get();

      // If not auto-developing, just return
      if (autoDevelop.status !== "running") return;

      // Check if this is the feature we were waiting for
      if (featureId && autoDevelop.currentFeatureId !== featureId) return;

      const nextIndex = autoDevelop.currentIndex + 1;
      const completedInSession = autoDevelop.completedInSession + 1;

      // Check if we're done
      if (nextIndex >= autoDevelop.queue.length) {
        set({
          autoDevelop: {
            ...autoDevelop,
            status: "completed",
            currentFeatureId: null,
            currentIndex: nextIndex,
            completedInSession,
          },
        });
        return;
      }

      // Start the next feature
      const nextFeatureId = autoDevelop.queue[nextIndex];

      set({
        autoDevelop: {
          ...autoDevelop,
          currentFeatureId: nextFeatureId,
          currentIndex: nextIndex,
          completedInSession,
        },
      });

      if (threadId) {
        try {
          await get().startFeatureDevelopment(nextFeatureId, { force: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to start next feature";
          set((state) => ({
            autoDevelop: {
              ...state.autoDevelop,
              status: "error",
              error: message,
            },
          }));
        }
      }
    },
    async respondToProposal(proposalId, action, options) {
      const { threadId, proposals, proposalActions } = get();
      if (!threadId || !proposalId) return;

      const target = proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );

      if (!target) return;

      set({
        proposalActions: {
          ...proposalActions,
          [proposalId]: {
            status: "pending",
            error: null,
            message: null,
            updatedAt: Date.now(),
          },
        },
      });

      try {
        const result = await performFeatureProposalAction({
          threadId,
          proposalId,
          featureId: target.featureId,
          action,
          rationale: options?.rationale,
        });

        set((state) => {
          const nextState = mapFetchResultToState(state, result);
          return {
            ...nextState,
            proposalActions: {
              ...nextState.proposalActions,
              [proposalId]: {
                status: "idle",
                error: null,
                message: result.message,
                updatedAt: Date.now(),
              },
            },
          };
        });

        return result.message ?? undefined;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to process proposal action";

        set((state) => ({
          ...state,
          proposalActions: {
            ...state.proposalActions,
            [proposalId]: {
              status: "error",
              error: message,
              updatedAt: Date.now(),
            },
          },
        }));
        throw new Error(message);
      }
    },
    setFeatureRunStatus(featureId, status, options) {
      if (!featureId) return;

      set((state) => {
        const current = state.featureRuns[featureId];

        return {
          ...state,
          featureRuns: {
            ...state.featureRuns,
            [featureId]: {
              threadId: options?.threadId ?? current?.threadId ?? null,
              runId: options?.runId ?? current?.runId ?? null,
              status,
              error: options?.error ?? null,
              updatedAt: Date.now(),
            },
          },
        };
      });

      // If completed, persist the completion to the backend and trigger auto-develop
      if (status === "completed") {
        get().completeFeature(featureId).catch((error) => {
          console.error("Failed to persist feature completion:", error);
        });
        // Trigger next feature in auto-develop queue
        get().onFeatureCompleted(featureId).catch((error) => {
          console.error("Failed to trigger next auto-develop feature:", error);
        });
      }
    },
    async completeFeature(featureId) {
      const { workspacePath, featuresById } = get();

      if (!workspacePath || !featureId || !featuresById[featureId]) {
        return;
      }

      try {
        const response = await fetch("/api/feature-graph/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_path: workspacePath,
            feature_id: featureId,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to mark feature as completed");
        }

        // Update local feature status
        set((state) => {
          const feature = state.featuresById[featureId];
          if (!feature) return state;

          const updatedFeature = { ...feature, status: "completed" };
          const updatedFeaturesById = {
            ...state.featuresById,
            [featureId]: updatedFeature,
          };
          const updatedFeatures = state.features.map((f) =>
            f.id === featureId ? updatedFeature : f,
          );

          return {
            ...state,
            features: updatedFeatures,
            featuresById: updatedFeaturesById,
          };
        });
      } catch (error) {
        console.error("Failed to complete feature:", error);
        throw error;
      }
    },
    async deleteFeature(featureId) {
      const { workspacePath, featuresById } = get();

      if (!workspacePath || !featureId || !featuresById[featureId]) {
        return;
      }

      try {
        const response = await fetch("/api/feature-graph/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_path: workspacePath,
            feature_id: featureId,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to delete feature");
        }

        // Remove feature from local state
        set((state) => {
          const { [featureId]: _removed, ...remainingFeaturesById } = state.featuresById;
          const updatedFeatures = state.features.filter((f) => f.id !== featureId);
          const updatedActiveFeatureIds = state.activeFeatureIds.filter((id) => id !== featureId);
          const { [featureId]: _removedRun, ...remainingFeatureRuns } = state.featureRuns;

          // Clear selection if deleted feature was selected
          const selectedFeatureId = state.selectedFeatureId === featureId
            ? (updatedFeatures[0]?.id ?? null)
            : state.selectedFeatureId;

          return {
            ...state,
            features: updatedFeatures,
            featuresById: remainingFeaturesById,
            activeFeatureIds: updatedActiveFeatureIds,
            featureRuns: remainingFeatureRuns,
            selectedFeatureId,
          };
        });
      } catch (error) {
        console.error("Failed to delete feature:", error);
        throw error;
      }
    },
    selectFeature(featureId) {
      if (!featureId) {
        set({ selectedFeatureId: null });
        return;
      }

      const { featuresById } = get();
      if (!featuresById[featureId]) return;

      set({ selectedFeatureId: featureId });
    },
    setActiveFeatureIds(featureIds) {
      const normalized = normalizeFeatureIds(featureIds);
      const state = get();

      const hasActiveFeatureIdsChanged =
        normalized.length !== state.activeFeatureIds.length ||
        normalized.some((id, index) => id !== state.activeFeatureIds[index]);

      if (normalized.length === 0) {
        if (!hasActiveFeatureIdsChanged) {
          return;
        }

        set({
          activeFeatureIds: [],
          selectedFeatureId: state.selectedFeatureId,
        });
        return;
      }

      const currentSelection = state.selectedFeatureId;
      const nextSelection =
        currentSelection && normalized.includes(currentSelection)
          ? currentSelection
          : (normalized.find((id) => Boolean(state.featuresById[id])) ?? null);

      if (
        !hasActiveFeatureIdsChanged &&
        nextSelection === state.selectedFeatureId
      ) {
        return;
      }

      set({
        activeFeatureIds: normalized,
        selectedFeatureId: nextSelection,
      });
    },
    setDesignThreadId(designThreadId) {
      set({ designThreadId });
    },
    setThreadId(threadId) {
      set({ threadId });
    },
    async startDesignDevelopment(featureIds, designThreadId) {
      if (!featureIds.length || !designThreadId) {
        throw new Error("Feature IDs and design thread ID are required");
      }

      // Mark features as starting
      const nextRunStates: Record<string, FeatureRunState> = {};
      for (const featureId of featureIds) {
        nextRunStates[featureId] = {
          threadId: null,
          runId: null,
          status: "starting",
          error: null,
          updatedAt: Date.now(),
        };
      }

      set((state) => ({
        ...state,
        featureRuns: {
          ...state.featureRuns,
          ...nextRunStates,
        },
      }));

      try {
        const response = await fetch("/api/design/handoff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            design_thread_id: designThreadId,
            feature_ids: featureIds,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to start development from design");
        }

        const data = await response.json();
        const plannerThreadId = data.planner_thread_id;
        const runId = data.run_id;

        // Update all features as running
        const runningStates: Record<string, FeatureRunState> = {};
        for (const featureId of featureIds) {
          runningStates[featureId] = {
            threadId: plannerThreadId,
            runId,
            status: "running",
            error: null,
            updatedAt: Date.now(),
          };
        }

        set((state) => {
          // Add featureIds to activeFeatureIds if not already present
          const existingIds = new Set(state.activeFeatureIds);
          const newActiveFeatureIds = [
            ...state.activeFeatureIds,
            ...featureIds.filter((id) => !existingIds.has(id)),
          ];

          return {
            ...state,
            activeFeatureIds: newActiveFeatureIds,
            featureRuns: {
              ...state.featureRuns,
              ...runningStates,
            },
          };
        });

        return { plannerThreadId, runId };
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Failed to start development from design";

        // Update all features as errored
        const errorStates: Record<string, FeatureRunState> = {};
        for (const featureId of featureIds) {
          errorStates[featureId] = {
            threadId: null,
            runId: null,
            status: "error",
            error: message,
            updatedAt: Date.now(),
          };
        }

        set((state) => ({
          ...state,
          featureRuns: {
            ...state.featureRuns,
            ...errorStates,
          },
        }));

        throw new Error(message);
      }
    },
    clear() {
      set({ ...INITIAL_STATE });
    },
  }),
);

function mapFetchResultToState(
  prevState: FeatureGraphStoreState,
  result: FeatureGraphFetchResult,
) {
  const { graph, features } = resolveGraphAndFeatures(result.graph);
  const proposalState = mapFeatureProposalState(
    { proposals: result.proposals, activeProposalId: result.activeProposalId },
  );

  const proposalActions = pruneProposalActions(
    prevState.proposalActions,
    proposalState.proposals,
  );

  if (!graph && features.length === 0) {
    return {
      ...prevState,
      graph: null,
      features: [],
      featuresById: {},
      testsByFeatureId: {},
      artifactsByFeatureId: {},
      activeFeatureIds: result.activeFeatureIds,
      proposals: proposalState.proposals,
      activeProposalId: proposalState.activeProposalId,
      proposalActions,
      selectedFeatureId: result.activeFeatureIds[0] ?? null,
      isLoading: false,
      isGeneratingGraph: false,
      error: null,
    } satisfies Partial<FeatureGraphStoreState>;
  }

  const featuresById: Record<string, FeatureNode> = {};
  for (const feature of features) {
    featuresById[feature.id] = feature;
  }

  const testsByFeatureId: Record<string, FeatureResource[]> = {};
  const artifactsByFeatureId: Record<string, FeatureResource[]> = {};

  for (const feature of features) {
    testsByFeatureId[feature.id] =
      graph === null
        ? []
        : dedupeResources(
            testsForFeature(graph, feature.id).map((ref, index) =>
              normalizeArtifactRef(ref, `Test ${index + 1}`),
            ),
          );

    artifactsByFeatureId[feature.id] = dedupeResources(
      collectFeatureArtifacts(feature.artifacts).map((ref, index) =>
        normalizeArtifactRef(ref, `Artifact ${index + 1}`),
      ),
    );
  }

  const selectedFeatureId = resolveSelectedFeatureId(
    prevState.selectedFeatureId,
    result.activeFeatureIds,
    features,
  );

  return {
    threadId: prevState.threadId,
    graph,
    features,
    featuresById,
    testsByFeatureId,
    artifactsByFeatureId,
    activeFeatureIds: result.activeFeatureIds,
    proposals: proposalState.proposals,
    activeProposalId: proposalState.activeProposalId,
    proposalActions,
    selectedFeatureId,
    isLoading: false,
    isGeneratingGraph: false,
    error: null,
  } satisfies Partial<FeatureGraphStoreState>;
}

function resolveGraphAndFeatures(graph: FeatureGraph | null) {
  const coercedGraph = coerceFeatureGraph(graph);
  const features = listFeaturesSafely(coercedGraph) ?? listSerializedFeatures(graph);

  return {
    graph: coercedGraph,
    features,
  };
}

function listFeaturesSafely(graph: FeatureGraph | null): FeatureNode[] | null {
  if (!graph || typeof graph.listFeatures !== "function") return null;

  try {
    return graph.listFeatures();
  } catch {
    return null;
  }
}

function listSerializedFeatures(graph: unknown): FeatureNode[] {
  if (!graph || typeof graph !== "object") return [];

  const nodes = (graph as { nodes?: unknown }).nodes;
  const candidates: unknown[] = [];

  if (nodes instanceof Map) {
    candidates.push(...nodes.values());
  } else if (Array.isArray(nodes)) {
    for (const entry of nodes) {
      if (Array.isArray(entry) && entry.length >= 2) {
        candidates.push(entry[1]);
        continue;
      }

      candidates.push(entry);
    }
  } else if (nodes && typeof nodes === "object") {
    candidates.push(...Object.values(nodes));
  }

  const features: FeatureNode[] = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    const feature = candidate as FeatureNode;
    if (
      typeof feature.id !== "string" ||
      typeof feature.name !== "string" ||
      typeof feature.description !== "string" ||
      typeof feature.status !== "string"
    ) {
      continue;
    }

    const normalized: FeatureNode = {
      id: feature.id,
      name: feature.name,
      description: feature.description,
      status: feature.status,
    };

    if ("group" in feature && typeof feature.group === "string") {
      normalized.group = feature.group;
    }

    if (
      "metadata" in feature &&
      feature.metadata &&
      typeof feature.metadata === "object" &&
      !Array.isArray(feature.metadata)
    ) {
      normalized.metadata = feature.metadata as Record<string, unknown>;
    }

    if ("artifacts" in feature) {
      normalized.artifacts = feature.artifacts;
    }

    features.push(normalized);
  }

  return features;
}

function pruneProposalActions(
  current: Record<string, ProposalActionState>,
  proposals: FeatureProposal[],
): Record<string, ProposalActionState> {
  const activeIds = new Set(proposals.map((proposal) => proposal.proposalId));

  return Object.fromEntries(
    Object.entries(current).filter(([proposalId]) => activeIds.has(proposalId)),
  );
}

function resolveSelectedFeatureId(
  currentSelection: string | null,
  activeFeatureIds: string[],
  features: FeatureNode[],
): string | null {
  if (
    currentSelection &&
    features.some((feature) => feature.id === currentSelection)
  ) {
    if (
      activeFeatureIds.length === 0 ||
      activeFeatureIds.includes(currentSelection)
    ) {
      return currentSelection;
    }
  }

  if (activeFeatureIds.length > 0) {
    const active = activeFeatureIds.find((id) =>
      features.some((feature) => feature.id === id),
    );
    if (active) {
      return active;
    }
  }

  return features[0]?.id ?? null;
}

function collectFeatureArtifacts(
  artifacts: ArtifactCollection | undefined,
): ArtifactRef[] {
  if (!artifacts) return [];

  if (Array.isArray(artifacts)) {
    return artifacts;
  }

  return Object.values(artifacts);
}

function normalizeArtifactRef(
  ref: ArtifactRef,
  fallbackLabel: string,
): FeatureResource {
  if (typeof ref === "string") {
    const label = ref.trim() || fallbackLabel;
    return {
      id: `string:${label}`,
      label,
    };
  }

  const label = pickFirst(
    ref.path,
    ref.name,
    ref.description,
    ref.url,
    ref.type,
    fallbackLabel,
  );

  const secondary = ref.path && ref.path !== label ? ref.path : undefined;
  const description =
    ref.description && ref.description !== label ? ref.description : undefined;

  const href = ref.url && isHttpUrl(ref.url) ? ref.url : undefined;

  return {
    id: `object:${ref.path ?? ref.url ?? label}`,
    label,
    secondaryLabel: secondary,
    description,
    href,
  };
}

function dedupeResources(resources: FeatureResource[]): FeatureResource[] {
  const map = new Map<string, FeatureResource>();
  for (const resource of resources) {
    if (!resource?.id) continue;
    if (!map.has(resource.id)) {
      map.set(resource.id, resource);
    }
  }
  return Array.from(map.values());
}

function pickFirst(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}
