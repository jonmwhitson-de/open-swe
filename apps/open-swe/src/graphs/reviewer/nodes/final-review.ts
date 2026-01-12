import { v4 as uuidv4 } from "uuid";
import {
  ReviewerGraphState,
  ReviewerGraphUpdate,
} from "@openswe/shared/open-swe/reviewer/types";
import { formatUserRequestPrompt } from "../../../utils/user-request.js";
import { formatPlanPromptWithSummaries } from "../../../utils/plan-prompt.js";
import {
  getActivePlanItems,
  getActiveTask,
  updateTaskPlanItems,
} from "@openswe/shared/open-swe/tasks";
import {
  createCodeReviewMarkTaskCompletedFields,
  createCodeReviewMarkTaskNotCompleteFields,
} from "@openswe/shared/open-swe/tools";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { createLogger, LogLevel } from "../../../utils/logger.js";

import {
  loadModel,
  supportsParallelToolCallsParam,
} from "../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import { GraphConfig, PlanItem } from "@openswe/shared/open-swe/types";
import { z } from "zod";
import { getMessageString } from "../../../utils/message/content.js";
import {
  AIMessage,
  BaseMessage,
  isAIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { trackCachePerformance } from "../../../utils/caching.js";
import { getModelManager } from "../../../utils/llms/model-manager.js";
import { createScratchpadTool } from "../../../tools/scratchpad.js";
import { shouldCreateIssue } from "../../../utils/should-create-issue.js";

const logger = createLogger(LogLevel.INFO, "FinalReview");

const SYSTEM_PROMPT = `You are a code reviewer for a software engineer working on a large codebase.

<primary_objective>
You've just finished reviewing the actions taken by the Programmer Assistant, and are ready to provide a final review. In this final review, you are to either:
1. Determine all of the necessary actions have been taken which completed the user's request, and all of the individual tasks outlined in the plan.
or
2. Determine that the actions taken are insufficient, and do not fully complete the user's request, and all of the individual tasks outlined in the plan.

If you determine that the task is completed, you may call the \`{COMPLETE_TOOL_NAME}\` tool, providing your final review.
If you determine that the task has not been fully completed, you may call the \`{NOT_COMPLETE_TOOL_NAME}\` tool, providing your review, and a list of additional actions to take which will successfully satisfy your review, and complete the task.
</primary_objective>

<context>
Here is the full list of actions you took during your review:
{REVIEW_ACTIONS}

{USER_REQUEST_PROMPT}

And here are the tasks which were outlined in the plan, and completed by the Programmer Assistant:
{PLANNED_TASKS}

Here are all of the notes you wrote to your scratchpad during the review:
{SCRATCHPAD_NOTES}
</context>

<review-guidelines>
IMPORTANT: Lean toward marking tasks as COMPLETE. Only mark as incomplete if there are critical functional issues.

When evaluating completion:
- Focus on whether the core functionality requested by the user has been implemented
- Accept reasonable implementations even if they differ from the exact plan
- Do NOT require perfection - working code that meets requirements is sufficient
- Minor style issues, missing comments, or optimization opportunities are NOT reasons to mark incomplete
- If tests pass and the feature works as intended, the task is likely complete

If you determine that the task is not completed:
- Only list CRITICAL missing items (max 5 actions)
- Formatting/linting scripts should always be executed last
- Focus on functional requirements, not stylistic preferences

Carefully read over all of the provided context above. If the core requirements are met, call the \`{COMPLETE_TOOL_NAME}\` tool.
Only call \`{NOT_COMPLETE_TOOL_NAME}\` if there are critical functional gaps that prevent the feature from working as intended.
</review-guidelines>`;

const getScratchpadNotesString = (messages: BaseMessage[]) => {
  return messages
    .filter(
      (m) =>
        isAIMessage(m) &&
        m.tool_calls?.length &&
        m.tool_calls?.some((tc) => tc.name === createScratchpadTool("").name),
    )
    .map((m) => {
      const scratchpadTool = (m as AIMessage).tool_calls?.find(
        (tc) => tc.name === createScratchpadTool("").name,
      );
      if (!scratchpadTool) {
        return "";
      }
      return `<scratchpad_entry>\n${scratchpadTool.args.scratchpad}\n</scratchpad_entry>`;
    })
    .join("\n");
};

const formatSystemPrompt = (state: ReviewerGraphState) => {
  const markCompletedToolName = createCodeReviewMarkTaskCompletedFields().name;
  const markNotCompleteToolName =
    createCodeReviewMarkTaskNotCompleteFields().name;
  const activePlan = getActivePlanItems(state.taskPlan);
  const tasksString = formatPlanPromptWithSummaries(activePlan);
  const messagesString = state.reviewerMessages
    .map(getMessageString)
    .join("\n");
  const scratchpadNotesString = getScratchpadNotesString(
    state.reviewerMessages,
  );

  return SYSTEM_PROMPT.replaceAll("{REVIEW_ACTIONS}", messagesString)
    .replaceAll(
      "{USER_REQUEST_PROMPT}",
      formatUserRequestPrompt(state.messages),
    )
    .replaceAll("{PLANNED_TASKS}", tasksString)
    .replaceAll("{COMPLETE_TOOL_NAME}", markCompletedToolName)
    .replaceAll("{NOT_COMPLETE_TOOL_NAME}", markNotCompleteToolName)
    .replaceAll("{SCRATCHPAD_NOTES}", scratchpadNotesString);
};

export async function finalReview(
  state: ReviewerGraphState,
  config: GraphConfig,
): Promise<ReviewerGraphUpdate> {
  const completedTool = createCodeReviewMarkTaskCompletedFields();
  const incompleteTool = createCodeReviewMarkTaskNotCompleteFields();
  const tools = [completedTool, incompleteTool];
  const model = await loadModel(config, LLMTask.REVIEWER);
  const modelManager = getModelManager();
  const modelName = modelManager.getModelNameForTask(config, LLMTask.REVIEWER);
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.REVIEWER,
  );
  const modelWithTools = model.bindTools(tools, {
    tool_choice: "any",
    ...(modelSupportsParallelToolCallsParam
      ? {
          parallel_tool_calls: false,
        }
      : {}),
  });

  const response = await modelWithTools.invoke([
    {
      role: "user",
      content: formatSystemPrompt(state),
    },
  ]);

  const toolCall = response.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("No tool call review generated");
  }

  if (toolCall.name === completedTool.name) {
    // Marked as completed. No further actions necessary.
    const toolMessage = new ToolMessage({
      id: uuidv4(),
      tool_call_id: toolCall.id ?? "",
      content: "Marked task as completed.",
    });
    const messagesUpdate = [response, toolMessage];
    return {
      messages: messagesUpdate,
      internalMessages: messagesUpdate,
      reviewerMessages: messagesUpdate,
    };
  }

  if (toolCall.name !== incompleteTool.name) {
    throw new Error("Invalid tool call");
  }

  // Not done. Add the new plan items to the task, then return.
  const newActions = (toolCall.args as z.infer<typeof incompleteTool.schema>)
    .additional_actions;
  const activeTask = getActiveTask(state.taskPlan);
  const activePlanItems = getActivePlanItems(state.taskPlan);
  const completedPlanItems = activePlanItems.filter((p) => p.completed);
  const newPlanItemsList: PlanItem[] = [
    // Only include completed plan items from the previous task plan in the update.
    ...completedPlanItems,
    ...newActions.map((a, index) => ({
      index: completedPlanItems.length + index,
      plan: a,
      completed: false,
      summary: undefined,
    })),
  ];
  const updatedTaskPlan = updateTaskPlanItems(
    state.taskPlan,
    activeTask.id,
    newPlanItemsList,
    "agent",
  );

  if (!isLocalMode(config) && shouldCreateIssue(config)) {
    logger.info("Skipping remote issue update: not supported");
  }

  const toolMessage = new ToolMessage({
    id: uuidv4(),
    tool_call_id: toolCall.id ?? "",
    content: "Marked task as incomplete.",
  });

  const messagesUpdate = [response, toolMessage];

  return {
    taskPlan: updatedTaskPlan,
    messages: messagesUpdate,
    internalMessages: messagesUpdate,
    reviewsCount: (state.reviewsCount || 0) + 1,
    tokenData: trackCachePerformance(response, modelName),
  };
}
