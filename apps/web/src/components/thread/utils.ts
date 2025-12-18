import type { Message } from "@langchain/langgraph-sdk";

/**
 * Extracts a string summary from a message's content, supporting multimodal (text, image, file, etc.).
 * - If text is present, returns the joined text.
 * - If not, returns a label for the first non-text modality (e.g., 'Image', 'Other').
 * - If unknown, returns 'Multimodal message'.
 */
export function getContentString(content: Message["content"]): string {
  if (typeof content === "string" || !content) return content;
  const texts = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);
  return texts.join(" ");
}

/**
 * Extracts reasoning text from a message's additional_kwargs.
 * This is used for Azure OpenAI / OpenAI o-series models that return reasoning
 * in additional_kwargs.reasoning.
 */
export function getReasoningFromMessage(message: Message): string | undefined {
  if (!message) return undefined;

  // Check for reasoning in additional_kwargs (Azure OpenAI / OpenAI o-series)
  const additionalKwargs = (message as any).additional_kwargs;
  if (additionalKwargs?.reasoning) {
    return String(additionalKwargs.reasoning);
  }

  // Check for thinking blocks in content (Anthropic extended thinking)
  if (Array.isArray(message.content)) {
    const thinkingBlocks = message.content.filter(
      (c: any) => c.type === "thinking" || c.type === "reasoning"
    );
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks
        .map((c: any) => c.thinking || c.reasoning || c.text || "")
        .filter(Boolean)
        .join("\n\n");
    }
  }

  return undefined;
}
