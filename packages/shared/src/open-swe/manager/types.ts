import { MessagesZodState } from "@langchain/langgraph";
import { TargetRepository, TaskPlan, AgentSession } from "../types.js";
import { FeatureGraph } from "../../feature-graph/graph.js";
import { z } from "zod";
import { withLangGraph } from "@langchain/langgraph/zod";

const isIterable = (value: unknown): value is Iterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";

export const FeatureProposalSchema = z.object({
  proposalId: z.string(),
  featureId: z.string(),
  summary: z.string(),
  status: z.enum(["proposed", "approved", "rejected"]),
  rationale: z.string().optional(),
  updatedAt: z.string(),
});

/**
 * Represents a feature draft captured during interview mode.
 * These are features discussed in conversation but not yet created in the graph.
 */
export const FeatureDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()).optional(),
  extractedAt: z.string(),
});

export const FeatureProposalStateSchema = z.object({
  proposals: z.array(FeatureProposalSchema),
  activeProposalId: z.string().optional(),
});

/**
 * State for interview mode - tracks features discussed during discovery conversation.
 */
export const InterviewModeStateSchema = z.object({
  /** Whether interview mode is active */
  isActive: z.boolean(),
  /** Features extracted from conversation but not yet created */
  featureDrafts: z.array(FeatureDraftSchema),
  /** Timestamp when interview started */
  startedAt: z.string().optional(),
});

export const ManagerGraphStateObj = MessagesZodState.extend({
  /**
   * The target repository the request should be executed in.
   */
  targetRepository: z.custom<TargetRepository>(),
  /**
   * Absolute path to the user's selected workspace when running locally.
   */
  workspaceAbsPath: z.string().optional(),
  /**
   * Resolved workspace path inside the container after validation.
   */
  workspacePath: withLangGraph(z.string().optional(), {
    reducer: {
      schema: z.string().optional(),
      fn: (_state, update) => update,
    },
  }),
  issueId: z.number().optional(),
  /**
   * The tasks generated for this request.
   */
  taskPlan: z.custom<TaskPlan>(),
  /**
   * The programmer session
   */
  programmerSession: z.custom<AgentSession>().optional(),
  /**
   * The planner session
   */
  plannerSession: z.custom<AgentSession>().optional(),
  /**
   * The branch name to checkout and make changes on.
   * Can be user specified, or defaults to `open-swe/<manager-thread-id>
   */
  branchName: z.string(),
  /**
   * Whether or not to auto accept the generated plan.
   */
  autoAcceptPlan: withLangGraph(z.custom<boolean>().optional(), {
    reducer: {
      schema: z.custom<boolean>().optional(),
      fn: (_state, update) => update,
    },
  }),
  /**
   * Handle to the feature graph declared within the target workspace.
   */
  featureGraph: withLangGraph<
    FeatureGraph | undefined,
    FeatureGraph | undefined,
    z.ZodType<FeatureGraph | undefined>
  >(z.custom<FeatureGraph>((value) => value instanceof FeatureGraph).optional(), {
    reducer: {
      schema: z.custom<FeatureGraph | undefined>((value) =>
        value === undefined || value instanceof FeatureGraph,
      ),
      fn: (state, update) => {
        if (!update) return state;
        if (!(update instanceof FeatureGraph)) return state;
        return update;
      },
    },
  }),
  /**
   * Feature identifiers that should be considered active for the current run.
   */
  activeFeatureIds: withLangGraph(z.array(z.string()).optional(), {
    reducer: {
      schema: z.custom<Iterable<unknown> | undefined>(),
      fn: (state, update) => {
        if (update === undefined || update === null) return state;
        if (!isIterable(update) || typeof update === "string") return state;

        const normalized: string[] = [];
        for (const value of update) {
          if (typeof value === "string") {
            normalized.push(value);
          }
        }

        return normalized;
      },
    },
  }),
  /**
   * Tracks whether the user has approved the active feature selection.
   */
  userHasApprovedFeature: withLangGraph(z.custom<boolean>().optional(), {
    reducer: {
      schema: z.custom<boolean>().optional(),
      fn: (state, update) => update ?? state,
    },
  }),
  /**
   * Tracks feature proposals and their lifecycle state across turns.
   */
  featureProposals: FeatureProposalStateSchema.optional(),
  /**
   * Interview mode state - tracks features discussed during discovery conversation.
   * When active, features are accumulated as drafts until user triggers batch generation.
   */
  interviewModeState: withLangGraph<
    z.infer<typeof InterviewModeStateSchema> | undefined,
    z.infer<typeof InterviewModeStateSchema> | undefined,
    z.ZodType<z.infer<typeof InterviewModeStateSchema> | undefined>
  >(InterviewModeStateSchema.optional(), {
    reducer: {
      schema: InterviewModeStateSchema.optional(),
      fn: (
        state: z.infer<typeof InterviewModeStateSchema> | undefined,
        update: z.infer<typeof InterviewModeStateSchema> | undefined,
      ) => {
        if (!update) return state;
        // Merge feature drafts if both exist
        if (state?.featureDrafts && update.featureDrafts) {
          const existingIds = new Set(state.featureDrafts.map((d) => d.id));
          const newDrafts = update.featureDrafts.filter(
            (d) => !existingIds.has(d.id),
          );
          return {
            ...update,
            featureDrafts: [...state.featureDrafts, ...newDrafts],
          };
        }
        return update;
      },
    },
  }),
});

export type ManagerGraphState = z.infer<typeof ManagerGraphStateObj>;
export type ManagerGraphUpdate = Partial<ManagerGraphState>;
export type FeatureProposal = z.infer<typeof FeatureProposalSchema>;
export type FeatureProposalState = z.infer<typeof FeatureProposalStateSchema>;
export type FeatureDraft = z.infer<typeof FeatureDraftSchema>;
export type InterviewModeState = z.infer<typeof InterviewModeStateSchema>;
