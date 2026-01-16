import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, END } from "@langchain/langgraph";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  FeatureProposal,
  FeatureProposalState,
  ManagerGraphState,
  ManagerGraphUpdate,
} from "@openswe/shared/open-swe/manager/types";
import { loadModel, supportsParallelToolCallsParam } from "../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import {
  BaseMessage,
  ToolMessage,
  isHumanMessage,
  isAIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { getMessageContentString } from "@openswe/shared/messages";
import {
  applyFeatureStatus,
  createFeatureNode,
  persistFeatureGraph,
} from "../utils/feature-graph-mutations.js";
import {
  FeatureGraph,
  listFeaturesFromGraph,
  loadFeatureGraph,
} from "@openswe/shared/feature-graph";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { FEATURE_GRAPH_RELATIVE_PATH } from "../utils/feature-graph-path.js";

const logger = createLogger(LogLevel.INFO, "FeatureGraphAgent");

const FEATURE_AGENT_SYSTEM_PROMPT = `You are the dedicated feature-graph concierge for Open SWE.

IMPORTANT: You MUST use tools to respond. Always call one of the provided tools.

When the user wants to ADD a new feature:
- Use create_feature with a unique featureId (e.g., "feature-user-auth"), descriptive name, and summary

When the user wants to PROPOSE changes to an existing feature:
- Use propose_feature_change with the featureId, summary, and a user-facing response

When the user APPROVES a proposal:
- Use approve_feature_change with the featureId to mark it as active

When the user REJECTS a proposal:
- Use reject_feature_change with the featureId to mark it as rejected

When you need more information or the request doesn't involve graph changes:
- Use reply_without_change with a clarifying question

Guidelines:
- Maintain an explicit propose/approve/reject loop with the user instead of jumping into planning.
- Persist proposal state across turns so the user can approve or reject later.
- Only mutate the feature graph through the provided tools; summarize every mutation in your response.
- If the feature graph is missing, use reply_without_change to ask for the workspace to be resolved.`;

const createFeatureSchema = z.object({
  featureId: z.string(),
  name: z.string(),
  summary: z.string(),
});

/**
 * Schema for batch feature extraction from interview conversation.
 * Used when user clicks "Generate all features" to create multiple features at once.
 */
const extractAndCreateFeaturesSchema = z.object({
  features: z.array(z.object({
    featureId: z.string().describe("Unique identifier for the feature, e.g., 'feature-user-auth'"),
    name: z.string().describe("Human-readable name for the feature"),
    description: z.string().describe("Detailed description of what this feature does"),
    dependencies: z.array(z.string()).optional().describe("IDs of other features this depends on"),
  })).describe("All features extracted from the conversation"),
  response: z.string().describe("Summary message to show the user about all created features"),
});

const proposeSchema = z.object({
  featureId: z.string(),
  summary: z.string(),
  rationale: z.string().optional(),
  response: z
    .string()
    .describe(
      "A concise user-facing update describing the proposal and the approval you need next.",
    ),
});

const approveSchema = z.object({
  featureId: z.string(),
  proposalId: z.string().optional(),
  rationale: z.string().optional(),
  response: z
    .string()
    .describe("A concise user-facing confirmation that the proposal is approved."),
});

const rejectSchema = z.object({
  featureId: z.string(),
  proposalId: z.string().optional(),
  rationale: z.string().optional(),
  response: z
    .string()
    .describe("A concise user-facing confirmation that the proposal is rejected."),
});

const replySchema = z.object({
  response: z
    .string()
    .describe(
      "A concise update to the user when no feature-graph mutation is required.",
    ),
});

const ensureProposalState = (
  state: FeatureProposalState | undefined,
): FeatureProposalState => state ?? { proposals: [] };

const initializeFeatureGraph = async (
  workspacePath: string | undefined,
): Promise<FeatureGraph | undefined> => {
  if (!workspacePath) return undefined;

  const graphPath = path.join(workspacePath, FEATURE_GRAPH_RELATIVE_PATH);

  try {
    const data = await loadFeatureGraph(graphPath);
    logger.info("Loaded feature graph from disk", { graphPath });
    return new FeatureGraph(data);
  } catch (error) {
    logger.warn("Falling back to an empty feature graph", {
      graphPath,
      error: error instanceof Error ? error.message : String(error),
    });

    const emptyGraph = new FeatureGraph({
      version: 1,
      nodes: new Map(),
      edges: [],
      artifacts: [],
    });

    await persistFeatureGraph(emptyGraph, workspacePath);

    return emptyGraph;
  }
};

const formatProposals = (state: FeatureProposalState): string => {
  if (!state.proposals.length) {
    return "No recorded proposals yet.";
  }

  return state.proposals
    .map((proposal) => {
      const status = proposal.status.toUpperCase();
      const rationale = proposal.rationale ? ` — ${proposal.rationale}` : "";
      return `${proposal.featureId}: ${proposal.summary} [${status}]${rationale}`;
    })
    .join("\n");
};

const formatFeatureCatalog = (
  featureGraph: FeatureGraph | undefined,
  activeFeatureIds: string[] | undefined,
): string => {
  if (!featureGraph) return "No feature graph available.";

  const activeIds = new Set(activeFeatureIds ?? []);
  const features = listFeaturesFromGraph(featureGraph.toJSON(), {
    activeFeatureIds,
  });

  return features
    .map((feature) => {
      const activeMarker = activeIds.has(feature.id) ? "(active)" : "";
      return `- ${feature.id} ${activeMarker}: ${feature.name} — ${feature.status}`;
    })
    .join("\n");
};

const normalizeFeatureIds = (
  value: string[] | undefined,
): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;

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

  return normalized.length > 0 ? normalized : undefined;
};

const mergeActiveFeatureIds = (
  nextIds: string | string[] | undefined,
  existingIds: string[] | undefined,
): string[] | undefined => {
  const combined = [
    ...(Array.isArray(nextIds) ? nextIds : nextIds ? [nextIds] : []),
    ...(existingIds ?? []),
  ];

  return normalizeFeatureIds(combined);
};

const upsertProposal = (
  state: FeatureProposalState,
  proposal: FeatureProposal,
): FeatureProposalState => {
  const proposals = state.proposals.filter(
    (existing) => existing.proposalId !== proposal.proposalId,
  );
  proposals.push(proposal);

  return {
    proposals,
    activeProposalId: proposal.proposalId,
  };
};

const recordAction = (
  toolName: string,
  toolCallId: string,
  content: string,
): ToolMessage =>
  new ToolMessage({
    content,
    tool_call_id: toolCallId,
    name: toolName,
  });

const nowIso = () => new Date().toISOString();

/**
 * Format conversation history for the agent to understand context.
 * Only includes the last few messages to keep context manageable.
 */
const formatConversationHistory = (messages: BaseMessage[]): string => {
  // Get the last 10 messages (excluding the current one)
  const recentMessages = messages.slice(-11, -1);

  if (recentMessages.length === 0) {
    return "No prior conversation.";
  }

  const formatted = recentMessages.map((msg) => {
    const role = isHumanMessage(msg) ? "User" : "Assistant";
    const content = getMessageContentString(msg.content);
    // Truncate long messages
    const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
    return `${role}: ${truncated}`;
  });

  return formatted.join("\n\n");
};

/**
 * Check if this is a "lock in" request where the user wants to finalize the feature.
 */
const isLockInRequest = (message: BaseMessage): boolean => {
  const content = getMessageContentString(message.content);
  return content.includes("[LOCK_IN_FEATURE]") ||
    (message.additional_kwargs?.lockInFeature === true);
};

/**
 * Check if this is a "generate all features" request where the user wants to
 * extract and create all features discussed in the interview conversation.
 */
const isGenerateAllFeaturesRequest = (message: BaseMessage): boolean => {
  const content = getMessageContentString(message.content);
  return content.includes("[GENERATE_ALL_FEATURES]") ||
    (message.additional_kwargs?.generateAllFeatures === true);
};

/**
 * Format the FULL conversation history for batch feature extraction.
 * Unlike formatConversationHistory, this includes the complete conversation
 * to ensure we capture all features discussed.
 */
const formatFullConversationHistory = (messages: BaseMessage[]): string => {
  // Filter out tool messages and system messages, keep human and AI messages
  const conversationMessages = messages.filter(
    (msg) => isHumanMessage(msg) || isAIMessage(msg),
  );

  if (conversationMessages.length === 0) {
    return "No conversation history.";
  }

  const formatted = conversationMessages.map((msg) => {
    const role = isHumanMessage(msg) ? "User" : "Assistant";
    const content = getMessageContentString(msg.content);
    // Don't truncate for full history - we want all context
    return `${role}: ${content}`;
  });

  return formatted.join("\n\n");
};

const BATCH_EXTRACTION_SYSTEM_PROMPT = `You are a feature extraction specialist for Open SWE.

Your task is to analyze the entire conversation and extract ALL features that were discussed.

IMPORTANT GUIDELINES:
1. Extract EVERY distinct feature mentioned in the conversation
2. Create unique, descriptive featureIds (e.g., "feature-user-authentication", "feature-payment-processing")
3. Write clear, detailed descriptions for each feature
4. Identify dependencies between features when mentioned
5. Do NOT skip any features - capture everything discussed
6. Consolidate similar discussions about the same feature into one entry

You MUST use the extract_and_create_features tool to output all the features at once.`;

/**
 * Handle the "Generate all features" request by extracting all features
 * from the conversation and creating them in batch.
 */
async function handleGenerateAllFeatures(
  state: ManagerGraphState,
  config: GraphConfig,
  featureGraph: FeatureGraph | undefined,
  fullConversationHistory: string,
): Promise<Command> {
  logger.info("Handling generate all features request", {
    workspacePath: state.workspacePath,
    messageCount: state.messages.length,
  });

  const systemPrompt = `${BATCH_EXTRACTION_SYSTEM_PROMPT}

# Full Conversation History
${fullConversationHistory}

# Current Feature Graph
${formatFeatureCatalog(featureGraph, state.activeFeatureIds)}`;

  const extractionTool = {
    name: "extract_and_create_features",
    description: "Extract all features from the conversation and create them in the feature graph.",
    schema: extractAndCreateFeaturesSchema,
  };

  const model = await loadModel(config, LLMTask.ROUTER);
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.ROUTER,
  );
  const modelWithTools = model.bindTools([extractionTool], {
    tool_choice: extractionTool.name,
    ...(modelSupportsParallelToolCallsParam
      ? { parallel_tool_calls: false }
      : {}),
  });

  const aiMessage = await modelWithTools.invoke([
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: "Extract and create all features discussed in this conversation.",
    },
  ]);

  const toolCall = aiMessage.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("No features extracted from conversation.");
  }

  const extractedData = toolCall.args as z.infer<typeof extractAndCreateFeaturesSchema>;
  const toolCallId = toolCall.id ?? randomUUID();

  logger.info("Extracted features from conversation", {
    featureCount: extractedData.features.length,
    featureIds: extractedData.features.map((f) => f.featureId),
  });

  let updatedGraph = featureGraph;
  const createdFeatures: string[] = [];
  const toolMessages: BaseMessage[] = [];

  // Create all extracted features in batch
  for (const feature of extractedData.features) {
    try {
      if (!updatedGraph) {
        updatedGraph = await initializeFeatureGraph(state.workspacePath);
        if (!updatedGraph) {
          throw new Error("Workspace path is not set; cannot initialize feature graph.");
        }
      }

      // Skip if feature already exists
      if (updatedGraph.hasFeature(feature.featureId)) {
        logger.info("Skipping existing feature", { featureId: feature.featureId });
        continue;
      }

      updatedGraph = await createFeatureNode(
        updatedGraph,
        {
          id: feature.featureId,
          name: feature.name,
          summary: feature.description,
        },
        state.workspacePath,
      );

      createdFeatures.push(feature.name);

      logger.info("Created feature from batch extraction", {
        featureId: feature.featureId,
        name: feature.name,
        hasDependencies: Boolean(feature.dependencies?.length),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to create feature from batch", {
        featureId: feature.featureId,
        error: errorMessage,
      });
    }
  }

  // Create summary response
  const summaryMessage = createdFeatures.length > 0
    ? `Created ${createdFeatures.length} features from our conversation:\n${createdFeatures.map((name) => `• ${name}`).join("\n")}\n\n${extractedData.response}`
    : "No new features were created. All discussed features may already exist in the graph.";

  toolMessages.push(
    recordAction("extract_and_create_features", toolCallId, summaryMessage),
  );

  // Collect all created feature IDs for activeFeatureIds
  const newActiveFeatureIds = extractedData.features
    .filter((f) => createdFeatures.includes(f.name))
    .map((f) => f.featureId);

  const updates: ManagerGraphUpdate = {
    messages: [aiMessage, ...toolMessages],
    ...(newActiveFeatureIds.length > 0
      ? { activeFeatureIds: mergeActiveFeatureIds(newActiveFeatureIds, state.activeFeatureIds) }
      : {}),
    // Clear interview mode state after successful generation
    interviewModeState: {
      isActive: false,
      featureDrafts: [],
    },
  };

  return new Command({
    update: updates,
    goto: END,
  });
}

export async function featureGraphAgent(
  state: ManagerGraphState,
  config: GraphConfig,
): Promise<Command> {
  const userMessage = state.messages.findLast(isHumanMessage);

  if (!userMessage) {
    throw new Error("No human message found.");
  }

  const proposalState = ensureProposalState(state.featureProposals);
  // Load feature graph from file instead of state to avoid storing it in state.
  // This prevents state from growing too large and causing serialization errors.
  const featureGraph = await initializeFeatureGraph(state.workspacePath);

  // Check if this is a lock-in request or generate all features request
  const isLockIn = isLockInRequest(userMessage);
  const isGenerateAll = isGenerateAllFeaturesRequest(userMessage);

  // Build the system prompt with conversation history for context
  const conversationHistory = formatConversationHistory(state.messages);

  // For generate all features, we use the full conversation (more context)
  const fullConversationHistory = isGenerateAll
    ? formatFullConversationHistory(state.messages)
    : conversationHistory;

  const lockInInstruction = isLockIn
    ? "\n\n# IMPORTANT: Lock-in Request\nThe user has clicked 'Lock in feature'. Based on the conversation history above, you MUST use the create_feature tool to add the discussed feature to the graph. Extract the feature name and description from the conversation and create it now."
    : "";

  // Handle "Generate all features" request - batch feature extraction
  if (isGenerateAll) {
    return await handleGenerateAllFeatures(
      state,
      config,
      featureGraph,
      fullConversationHistory,
    );
  }

  const systemPrompt = `${FEATURE_AGENT_SYSTEM_PROMPT}\n\n# Conversation History\n${conversationHistory}\n\n# Current Proposals\n${formatProposals(proposalState)}\n\n# Feature Graph\n${formatFeatureCatalog(featureGraph, state.activeFeatureIds)}${lockInInstruction}`;

  const tools = [
    {
      name: "create_feature",
      description: "Add a new feature node to the feature graph before proposing changes.",
      schema: createFeatureSchema,
    },
    {
      name: "propose_feature_change",
      description:
        "Propose a new or updated feature definition in the graph and request approval.",
      schema: proposeSchema,
    },
    {
      name: "approve_feature_change",
      description: "Mark a pending proposal as approved and activate the feature.",
      schema: approveSchema,
    },
    {
      name: "reject_feature_change",
      description: "Reject a pending proposal and record the rationale.",
      schema: rejectSchema,
    },
    {
      name: "reply_without_change",
      description:
        "Respond to the user without mutating the feature graph when more info is needed.",
      schema: replySchema,
    },
  ];

  const model = await loadModel(config, LLMTask.ROUTER);
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.ROUTER,
  );
  const modelWithTools = model.bindTools(tools, {
    // Force the model to call at least one tool to ensure features are created/modified
    tool_choice: "required",
    ...(modelSupportsParallelToolCallsParam
      ? { parallel_tool_calls: false }
      : {}),
  });

  logger.info("Invoking feature graph agent", {
    workspacePath: state.workspacePath,
    hasFeatureGraph: Boolean(featureGraph),
    featureCount: featureGraph?.listFeatures().length ?? 0,
    isLockIn,
    isGenerateAll,
    userMessage: getMessageContentString(userMessage.content).slice(0, 100),
  });

  const aiMessage = await modelWithTools.invoke([
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: getMessageContentString(userMessage.content),
    },
  ]);

  logger.info("Feature graph agent LLM response", {
    hasToolCalls: Boolean(aiMessage.tool_calls?.length),
    toolCallCount: aiMessage.tool_calls?.length ?? 0,
    toolNames: aiMessage.tool_calls?.map((tc) => tc.name) ?? [],
  });

  let updatedGraph = featureGraph;
  let updatedProposals = proposalState;
  let updatedActiveFeatureIds = normalizeFeatureIds(state.activeFeatureIds);
  const toolMessages: BaseMessage[] = [];
  const userFacingSummaries: string[] = [];

  for (const toolCall of aiMessage.tool_calls ?? []) {
    const toolCallId = toolCall.id ?? randomUUID();

    try {
      switch (toolCall.name) {
        case "create_feature": {
          const args = toolCall.args as z.infer<typeof createFeatureSchema>;

          if (!updatedGraph) {
            updatedGraph = await initializeFeatureGraph(state.workspacePath);

            if (!updatedGraph) {
              throw new Error(
                "Workspace path is not set; cannot initialize feature graph.",
              );
            }
          }

          updatedGraph = await createFeatureNode(
            updatedGraph,
            {
              id: args.featureId,
              name: args.name,
              summary: args.summary,
            },
            state.workspacePath,
          );

          logger.info("Created feature node", {
            featureId: args.featureId,
            name: args.name,
            workspacePath: state.workspacePath,
          });

          const response = `Added ${args.name} (${args.featureId}) to the feature graph.`;
          toolMessages.push(recordAction(toolCall.name, toolCallId, response));
          userFacingSummaries.push(response);
          break;
        }
        case "propose_feature_change": {
          const args = toolCall.args as z.infer<typeof proposeSchema>;
          const proposalId = randomUUID();
          const proposal: FeatureProposal = {
            proposalId,
            featureId: args.featureId,
            summary: args.summary,
            status: "proposed",
            rationale: args.rationale,
            updatedAt: nowIso(),
          };
          updatedProposals = upsertProposal(updatedProposals, proposal);

          logger.info("Recorded feature proposal", {
            action: toolCall.name,
            featureId: args.featureId,
            proposalId,
            status: proposal.status,
          });

          let creationSummary: string | undefined;

          if (!updatedGraph) {
            updatedGraph = await initializeFeatureGraph(state.workspacePath);
          }

          if (updatedGraph) {
            if (!updatedGraph.hasFeature(args.featureId)) {
              updatedGraph = await createFeatureNode(
                updatedGraph,
                {
                  id: args.featureId,
                  name: args.featureId,
                  summary: args.summary,
                },
                state.workspacePath,
              );
              creationSummary = `Initialized ${args.featureId} in the feature graph.`;
            }

            updatedGraph = applyFeatureStatus(
              updatedGraph,
              args.featureId,
              "proposed",
            );
            await persistFeatureGraph(updatedGraph, state.workspacePath);

            logger.info("Updated feature graph status", {
              featureId: args.featureId,
              proposalId,
              status: "proposed",
            });
          }

          const response = [
            creationSummary,
            args.response ||
              `Proposed update for ${args.featureId}. Awaiting your approval.`,
          ]
            .filter(Boolean)
            .join(" ");
          toolMessages.push(recordAction(toolCall.name, toolCallId, response));
          userFacingSummaries.push(response);
          break;
        }
        case "approve_feature_change": {
          const args = toolCall.args as z.infer<typeof approveSchema>;
          const matchingProposal = updatedProposals.proposals.find(
            (proposal) =>
              proposal.proposalId === args.proposalId ||
              proposal.featureId === args.featureId,
          );
          const proposal: FeatureProposal = {
            proposalId: matchingProposal?.proposalId ?? randomUUID(),
            featureId: args.featureId,
            summary:
              matchingProposal?.summary ??
              `Approved update for ${args.featureId}`,
            status: "approved",
            rationale: args.rationale,
            updatedAt: nowIso(),
          };
          updatedProposals = upsertProposal(updatedProposals, proposal);

          logger.info("Approved feature proposal", {
            action: toolCall.name,
            featureId: args.featureId,
            proposalId: proposal.proposalId,
            status: proposal.status,
          });

          if (updatedGraph) {
            updatedGraph = applyFeatureStatus(
              updatedGraph,
              args.featureId,
              "active",
            );
            await persistFeatureGraph(updatedGraph, state.workspacePath);

            logger.info("Activated feature in graph", {
              featureId: args.featureId,
              proposalId: proposal.proposalId,
              status: "active",
            });
          }

          updatedActiveFeatureIds = mergeActiveFeatureIds(
            args.featureId,
            updatedActiveFeatureIds ?? state.activeFeatureIds,
          );

          const response = args.response ||
            `Marked ${args.featureId} as approved and ready for planning.`;
          toolMessages.push(
            recordAction(toolCall.name, toolCallId, response),
          );
          userFacingSummaries.push(response);
          break;
        }
        case "reject_feature_change": {
          const args = toolCall.args as z.infer<typeof rejectSchema>;
          const matchingProposal = updatedProposals.proposals.find(
            (proposal) =>
              proposal.proposalId === args.proposalId ||
              proposal.featureId === args.featureId,
          );
          const proposal: FeatureProposal = {
            proposalId: matchingProposal?.proposalId ?? randomUUID(),
            featureId: args.featureId,
            summary:
              matchingProposal?.summary ?? `Rejected update for ${args.featureId}`,
            status: "rejected",
            rationale: args.rationale,
            updatedAt: nowIso(),
          };
          updatedProposals = upsertProposal(updatedProposals, proposal);

          logger.info("Rejected feature proposal", {
            action: toolCall.name,
            featureId: args.featureId,
            proposalId: proposal.proposalId,
            status: proposal.status,
          });

          if (updatedGraph) {
            updatedGraph = applyFeatureStatus(
              updatedGraph,
              args.featureId,
              "rejected",
            );
            await persistFeatureGraph(updatedGraph, state.workspacePath);

            logger.info("Updated rejected feature in graph", {
              featureId: args.featureId,
              proposalId: proposal.proposalId,
              status: "rejected",
            });
          }

          const response =
            args.response ||
            `Logged rejection for ${args.featureId} so we do not plan against it.`;
          toolMessages.push(recordAction(toolCall.name, toolCallId, response));
          userFacingSummaries.push(response);
          break;
        }
        case "reply_without_change": {
          const args = toolCall.args as z.infer<typeof replySchema>;
          toolMessages.push(
            recordAction(toolCall.name, toolCallId, args.response),
          );
          userFacingSummaries.push(args.response);
          break;
        }
        default: {
          toolMessages.push(
            recordAction(
              toolCall.name,
              toolCallId,
              `Unsupported action ${toolCall.name}.`,
            ),
          );
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      const toolArgs = toolCall.args as Record<string, unknown> | undefined;
      logger.error("Failed to process feature graph action", {
        action: toolCall.name,
        featureId:
          toolArgs && typeof toolArgs.featureId === "string"
            ? toolArgs.featureId
            : undefined,
        proposalId:
          toolArgs && typeof toolArgs.proposalId === "string"
            ? toolArgs.proposalId
            : undefined,
        error: errorMessage,
      });
      toolMessages.push(
        recordAction(
          toolCall.name,
          toolCallId,
          `Could not process ${toolCall.name}: ${errorMessage}`,
        ),
      );
      userFacingSummaries.push(
        `I couldn't complete ${toolCall.name}. Please restate the feature and desired status.`,
      );
    }
  }

  // Don't add a separate responseMessage - the summaries are already in toolMessages
  // Adding both causes duplicate content in the UI
  // NOTE: We intentionally do NOT include featureGraph in the state update.
  // The graph is persisted directly to file and reloaded on each invocation.
  // This prevents state from growing too large and causing serialization errors.
  const updates: ManagerGraphUpdate = {
    messages: [aiMessage, ...toolMessages],
    featureProposals: updatedProposals,
    ...(updatedActiveFeatureIds
      ? { activeFeatureIds: updatedActiveFeatureIds }
      : {}),
  };

  return new Command({
    update: updates,
    goto: END,
  });
}
