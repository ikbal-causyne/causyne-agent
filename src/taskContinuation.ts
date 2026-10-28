/** Detect a peer's plan-review stop without turning a planning request into execution. */
export function isPlanReviewHandoff(content: string): boolean {
  return /\b(?:click|press|select)\s+["'`*]*(?:proceed|implement|approve)\b/i.test(content)
    || /\b(?:review|approve)\b[\s\S]{0,100}\b(?:plan|implementation outline)\b/i.test(content)
    || /\b(?:silakan tinjau|tinjau rencananya|klik\s+["'`*]*proceed)\b/i.test(content);
}

export function isPlanningOnlyRequest(prompt: string): boolean {
  return /\b(?:only|just)\s+(?:a\s+)?(?:plan|planning|research|analysis)\b/i.test(prompt)
    || /\b(?:do not|don't|without)\s+(?:implement|code|edit|build|chang(?:e|ing))\b/i.test(prompt)
    || /\b(?:plan|research|analy[sz]e)\s+(?:only|first)\b[\s\S]{0,80}\b(?:stop|wait|approval|review)\b/i.test(prompt)
    || /\b(?:rencana saja|hanya rencana|jangan\s+(?:implementasi|eksekusi|mengubah))\b/i.test(prompt);
}
