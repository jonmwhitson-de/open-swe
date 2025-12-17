import { END, START, StateGraph } from "@langchain/langgraph";
import { GraphConfiguration } from "@openswe/shared/open-swe/types";
import { DesignGraphStateObj } from "@openswe/shared/open-swe/design/types";
import {
  designAgent,
  handoffToPlanner,
  classifyDesignIntent,
} from "./nodes/index.js";

/**
 * Design Graph - A dedicated graph for feature graph design conversations.
 *
 * This graph runs in isolation from the manager and planner graphs to:
 * 1. Prevent "thread busy" errors when kicking off development
 * 2. Enable focused, iterative feature design conversations
 * 3. Allow clean handoff to planner without thread conflicts
 *
 * Flow:
 * START → classify-design-intent →
 *   - design-agent (for feature design conversations) → END
 *   - handoff-to-planner (when ready to develop) → END
 *   - END (when design session is complete)
 */

// Build the graph with explicit type annotation to help TypeScript
const builder = new StateGraph(DesignGraphStateObj, GraphConfiguration);

builder.addNode("classify-design-intent", classifyDesignIntent, {
  ends: [END, "design-agent", "handoff-to-planner"],
});
builder.addNode("design-agent", designAgent, {
  ends: [END],
});
builder.addNode("handoff-to-planner", handoffToPlanner, {
  ends: [END],
});

builder.addEdge(START, "classify-design-intent");
builder.addEdge("classify-design-intent", "design-agent");
builder.addEdge("classify-design-intent", "handoff-to-planner");
builder.addEdge("classify-design-intent", END);
builder.addEdge("design-agent", END);
builder.addEdge("handoff-to-planner", END);

export const graph = builder.compile();
graph.name = "Open SWE - Design";
