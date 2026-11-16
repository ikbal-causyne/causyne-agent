# /usage accuracy and scope contract

The `/usage` card is an **on-demand snapshot of the Causyne local tracker**.
It is not an invoice, a complete account-wide usage report, or an authoritative
provider context meter. The TUI must not present inferred figures as verified.

## Data lineage

| Display | Source | Correct interpretation |
| --- | --- | --- |
| Session/chat | `loop.memoryManager.sessionId` | Current session identifier, or unknown |
| Message count | `loop.messages` / `loadHistory()` | Count of stored message entries, including roles beyond user/assistant |
| Active model/provider | Running `loop.config`, falling back to saved config | Local runtime selection, not a remote model identity attestation |
| Context estimate | Rough text length / 4, estimated tool schemas, model configuration/known-family defaults | Approximation only; cannot infer actual provider tokenization, remote system prompts or truncation |
| This session/current run | `loop.tokenTracker.sessionTokens` | In-memory tracker since the current agent instance started; **does not necessarily survive an app restart** |
| Today (local) | `~/.causyne/usage/YYYY-MM-DD.json` | Local-calendar-day ledger; **not a rolling 24 hours** |
| All-time | `~/.causyne/usage/byok_cumulative.json`, optionally backfilled from dated files | Locally accumulated events; not a verified total across providers or accounts |
| Cost estimate | Locally recorded `totalCostUsd` using a rate-card approximation | Never an invoice or proof of actual charges; especially unreliable for bundled/free/ACP subscriptions |

### Critical source limitation: ACP text estimates

`src/providers/acp.ts` creates `ChatResponse.usage` from input/output
text lengths divided by four and marks it `measurement: 'text_estimate'`.
`src/agentLoop.ts` feeds it to `TokenTracker.trackUsage()`, which
aggregates it together with provider-reported usage. Cached input may be
excluded from tracked tokens; `trackMediaUsage()` adds synthetic token
equivalents. **Historical cumulative values cannot be retroactively
classified as exact vs estimated from the aggregate alone.** Do not guess
or rewrite these files to make totals look plausible.

A local cumulative value such as `103,928,594` tracked tokens across
`3,446,106` events can therefore exist in the ledger without proving
103 million actual model tokens or 3.4 million remote API requests.

### Context telemetry

The Agent Client Protocol defines optional `usage_update` session
notifications with `used` (tokens currently in context), `size` (context
window size), and optional cost/currency. These are stronger evidence
*when the peer actually supplies them*. This implementation does not claim
such telemetry when none was received. A guessed 128k window from a model
family is an **inferred cap**, not a provider-verified capacity.

ACP schema reference:
https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates

## Presentation invariants

- Keep model and provider separate: both are long strings for ACP peers.
- Use a single, compact, width-safe card; no long token progress bar that
  suggests precision unsupported by the telemetry.
- Label context *estimate* and whether the cap is `configured` or `inferred`.
- Name calendar-day scope explicitly. Name the current run/process scope.
- Cost fields always say *estimated* and *not provider billing*; zero
  local estimates are not evidence of no actual charges.
- Do not silently replace unavailable live session counters with a
  fabricated zero when no active tracker exists.
- Stable full-width borders, no terminal-column overflow on narrow widths.
- No modification to the underlying usage history, budget controls,
  agent loop, or model protocols to change the way the numbers look.

## Verification gates

- `tests/tuiUsageAccuracy.test.ts`: source/model precedence, inferred vs
  configured cap, snapshot labels, narrow terminal rendering, missing tracker.
- `tests/usageCard.test.ts`: command integration, existing numeric API,
  sanitized terminal content.
- `tests/tuiUsageCardFinite.test.ts`: NaN/Infinity and malformed fields.
- `npm run build`, `git diff --exit-code`, and CI on all three platforms.

To resolve a billing dispute, compare the provider's official usage/billing
records or a peer's actual reported telemetry with the locally stored usage
files. The local tracker alone cannot establish which historic entries were
estimate-based or whether they were charged.
