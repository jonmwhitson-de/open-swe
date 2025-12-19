import { z } from "zod";

export const BASE_CLASSIFICATION_SCHEMA = z.object({
  internal_reasoning: z
    .string()
    .describe(
      "The reasoning being the decision of the route you're going to take. This is internal, and not shown to the user, so you may be technical in your reasoning. Please include all the reasoning, and context which led you to choose this route.",
    ),
  response: z
    .string()
    .describe(
      "The response to send to the user. This should be clear, concise, and include any additional context the user may need to know about how/why you're handling their new message.",
    ),
  route: z
    .enum(["no_op"])
    .describe("The route to take to handle the user's new message."),
  needs_user_clarification: z
    .boolean()
    .optional()
    .describe(
      "Set to true if your response asks the user a clarifying question and you need their answer before proceeding. When true, the system will wait for the user's response before continuing. Use this when you need more information about requirements, scope, or implementation details.",
    ),
});

export function createClassificationSchema(enumOptions: [string, ...string[]]) {
  const schema = BASE_CLASSIFICATION_SCHEMA.extend({
    route: z
      .enum(enumOptions)
      .describe("The route to take to handle the user's new message."),
  });

  return schema;
}
