import { HumanResponse } from "@langchain/langgraph/prebuilt";
import { useEffect, useState } from "react";
import { PlanItem } from "@openswe/shared/open-swe/types";
import { convertPlanItemsToInterruptString } from "@/lib/plan-utils";
import { PLAN_INTERRUPT_ACTION_TITLE } from "@openswe/shared/constants";
import { useStream } from "@langchain/langgraph-sdk/react";

export function useProposedPlan(
  originalPlanItems: PlanItem[],
  stream: ReturnType<typeof useStream>,
) {
  const [planItems, setPlanItems] = useState<PlanItem[]>(originalPlanItems);
  const [changesMade, setChangesMade] = useState(false);

  useEffect(() => {
    setChangesMade(
      JSON.stringify(originalPlanItems) !== JSON.stringify(planItems),
    );
  }, [originalPlanItems, planItems]);

  const handleResumePlan = async () => {
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
      threadId: stream.threadId,
      hasInterrupt: !!stream.interrupt,
      isLoading: stream.isLoading,
    });

    try {
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
      console.log("[useProposedPlan] Plan resume submitted successfully");
    } catch (error) {
      console.error("[useProposedPlan] Failed to resume plan:", error);
    }
  };

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
