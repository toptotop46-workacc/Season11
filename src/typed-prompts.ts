import prompts, { type PromptObject, type Answers } from 'prompts'

/**
 * Typed wrapper around `prompts` that avoids `as any` casts.
 *
 * The upstream @types/prompts doesn't fully cover all option combos
 * (e.g. `number` prompt with float `increment`, `multiselect` with `hint`).
 * This wrapper accepts a looser input type and returns a typed result.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ask<T extends string = string> (question: PromptObject<T> & Record<string, any>): Promise<Answers<T>> {
  return prompts(question as PromptObject<T>)
}
