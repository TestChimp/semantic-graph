/** OpenAI model for trivial LLM tasks (cluster labels, etc.). */
export const VERY_CHEAP_MODEL = 'gpt-5-nano';

/** Default cheap Anthropic model for the same class of tasks. */
export const DEFAULT_ANTHROPIC_CHEAP_MODEL = 'claude-3-5-haiku-latest';

/** GPT-5 and o-series models require max_completion_tokens instead of max_tokens. */
export function openAiTokenLimitOptions(
  model: string,
  limit: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  if (/^(gpt-5|o\d)/i.test(model)) {
    return { max_completion_tokens: limit };
  }
  return { max_tokens: limit };
}
