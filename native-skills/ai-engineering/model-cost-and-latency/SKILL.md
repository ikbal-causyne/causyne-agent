---
name: model-cost-and-latency
description: Reduce the cost or latency of a language-model feature. Use when spend is higher than expected, when responses are slow, or when choosing a model.
---

# Model Cost and Latency

## Where the money goes

Input tokens, usually. A long system prompt sent on every request dominates spend far more often than output length does. Measure before optimising anything.

## Workflow

1. Instrument per-call cost and latency.
   - Input tokens, output tokens, cached tokens, model, and latency, tagged by feature. Without this you are optimising by anecdote.
   - **Done when:** cost per feature is visible on a dashboard.

2. Maximise prompt caching.
   - Put stable content first and keep the prefix byte-identical. A cached prefix is dramatically cheaper and faster, and this is usually the single largest available win — before any model change.
   - **Done when:** the cache hit rate is measured and the prefix is stable.

3. Route by difficulty.
   - Most requests do not need the largest model. Use a small fast model by default and escalate on a measurable signal — low confidence, a failed validation, or a complexity classifier.
   - **Done when:** the routing rule is stated and its accuracy is measured on the evaluation set.

4. Stream to fix perceived latency.
   - Time to first token is what users feel. Streaming makes a slow response feel responsive without making it faster.
   - **Done when:** the user sees output within a few hundred milliseconds.

5. Cut the input before cutting the model.
   - Trim the system prompt, remove unused tool definitions, retrieve less and rank better. Halving the input often costs no quality at all, where a smaller model might.
   - **Done when:** every section of the prompt has been justified against its token cost.

6. Cache complete responses where the input repeats.
   - Identical or near-identical requests do not need a second call. Semantic caching catches paraphrases, with a similarity threshold tuned to avoid wrong hits.
   - **Done when:** repeated questions are served without a model call.

7. Verify quality did not regress.
   - Every cost reduction must be checked against the evaluation set. A cheaper wrong answer is not cheaper.
   - **Done when:** the evaluation score is unchanged or the trade-off is stated explicitly.

## Verification

- Cost per request is reported before and after.
- Cache hit rate is measured.
- Evaluation scores are unchanged, or the regression is quantified and accepted.
