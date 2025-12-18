import { HumanResponse } from "@langchain/langgraph/prebuilt";
import { useEffect, useState, useCallback } from "react";
import { PlanItem } from "@openswe/shared/open-swe/types";
import { convertPlanItemsToInterruptString } from "@/lib/plan-utils";
import { PLAN_INTERRUPT_ACTION_TITLE, OPEN_SWE_STREAM_MODE } from "@openswe/shared/constants";
import { useStream } from "@langchain/langgraph-sdk/react";
import { StreamMode } from "@langchain/langgraph-sdk";

export function useProposedPlan(
  originalPlanItems: PlanItem[],
  stream: ReturnType<typeof useStream>,
  threadId?: string,
) {
  const [planItems, setPlanItems] = useState<PlanItem[]>(originalPlanItems);
  const [changesMade, setChangesMade] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setChangesMade(
      JSON.stringify(originalPlanItems) !== JSON.stringify(planItems),
    );
  }, [originalPlanItems, planItems]);

  const handleResumePlan = useCallback(async () => {
    if (isSubmitting) {
      console.log("[useProposedPlan] Already submitting, ignoring click");
      return;
    }

    setIsSubmitting(true);

    let resume: HumanResponse[];
    if (changesMade) {
      resume = [
        {
          type: "edit",
          args: {
            action: PLAN_INTERRUPT_ACTION_TITLE,
            args: {
              plan: convertPlanItemsToInterruptString(planItems),
            },
          },
        },
      ];
    } else {
      resume = [
        {
          type: "accept",
          args: null,
        },
      ];
    }

    console.log("[useProposedPlan] Resuming plan with:", {
      resumeType: resume[0].type,
      threadId,
      hasInterrupt: !!stream.interrupt,
      isLoading: stream.isLoading,
      hasClient: !!stream.client,
    });

    if (!threadId) {
      console.error("[useProposedPlan] No threadId available for resume");
      setIsSubmitting(false);
      return;
    }

    try {
      // Try stream.submit first
      await stream.submit(
        {},
        {
          command: {
            resume,
          },
          config: {
            recursion_limit: 400,
          },
          streamResumable: true,
        },
      );
      console.log("[useProposedPlan] Plan resume submitted via stream.submit");
    } catch (submitError) {
      console.error("[useProposedPlan] stream.submit failed:", submitError);

      // Fallback: try using the client directly
      if (stream.client) {
        try {
          console.log("[useProposedPlan] Attempting direct client.runs.create with resume...");
          const run = await stream.client.runs.create(threadId, stream.assistantId, {
            command: {
              resume,
            },
            config: {
              recursion_limit: 400,
            },
            streamMode: OPEN_SWE_STREAM_MODE as StreamMode[],
            streamResumable: true,
          });
          console.log("[useProposedPlan] Direct client resume succeeded:", run.run_id);

          // Join the new run's stream
          if (run.run_id) {
            stream.joinStream(run.run_id).catch((joinErr) => {
              console.error("[useProposedPlan] Failed to join resumed run stream:", joinErr);
            });
          }
        } catch (clientError) {
          console.error("[useProposedPlan] Direct client resume failed:", clientError);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [changesMade, isSubmitting, planItems, stream, threadId]);

  const handleRejectPlan = () => {
    const resume: HumanResponse[] = [
      {
        type: "ignore",
        args: null,
      },
    ];
    stream.submit(
      {},
      {
        command: {
          resume,
        },
        config: {
          recursion_limit: 400,
        },
        streamResumable: true,
      },
    );
  };

  return {
    changesMade,
    planItems,
    setPlanItems,
    handleResumePlan,
    handleRejectPlan,
  };
}
