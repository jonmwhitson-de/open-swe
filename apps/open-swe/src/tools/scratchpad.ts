import { tool } from "@langchain/core/tools";
import { getStore, type BaseStore } from "@langchain/langgraph";
import { createScratchpadFields } from "@openswe/shared/open-swe/tools";

export async function writeScratchpad(
  input: {
    scratchpad: string[];
  },
  store?: BaseStore,
): Promise<{ result: string; status: "success" | "error" }> {
  const resolvedStore = store ?? getStore();
  if (!resolvedStore) {
    return {
      result: "Unable to access scratchpad store.",
      status: "error",
    };
  }

  const existing = await resolvedStore.get(["scratchpad"], "notes");
  const previousNotes = (existing?.value?.notes as string[] | undefined) ?? [];

  await resolvedStore.put(["scratchpad"], "notes", {
    notes: [...previousNotes, ...input.scratchpad],
  });

  return {
    result: "Successfully wrote to scratchpad. Thank you!",
    status: "success",
  };
}

export function createScratchpadTool(whenMessage: string, store?: BaseStore) {
  const scratchpadTool = tool(
    (input: { scratchpad: string[] }) => writeScratchpad(input, store),
    createScratchpadFields(whenMessage),
  );

  return scratchpadTool;
}
