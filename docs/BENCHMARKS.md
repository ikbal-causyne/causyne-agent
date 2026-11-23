# Causyne Agent Benchmarks & Verification

Measurement date: 2026-11-23. All figures below reflect observed local and CI runs
against the repository source; no external or synthetic benchmark claims are
included.

## 1. Reproducible Harness Coding Eval (`npm run verify:bench`)

`src/benchmarks/codingEval.ts` runs 15 isolated temporary-repository tasks with
real filesystem I/O, real Git operations, real OS-sandboxed background tasks,
and real `node --test` assertions:

| # | Task ID | Category | Verified Invariant |
| ---: | --- | --- | --- |
| 1 | `bugfix-clamp-range` | `bugfix` | Surgical `fs_read` + `fs_edit` fix verified by `node --test` |
| 2 | `refactor-multi-edit` | `refactor` | Atomic multi-hunk `MultiEdit` refactor verified by `node --test` |
| 3 | `parallel-worktree-merge` | `parallel-worktree` | Two concurrent isolated Git worktrees merged with zero collisions |
| 4 | `structured-diff-review` | `diff-review` | Unified diff parser exact file/hunk addition & deletion counts |
| 5 | `enterprise-policy-gate` | `governance` | Deterministic `deny`/`ask` enforcement for commands and `.env*` paths |
| 6 | `multi-file-apply-patch` | `multi-file-patch` | Atomic V4A multi-file `apply_patch` (add + update) verified by `node --test` |
| 7 | `repo-map-centrality` | `repo-map` | PageRank dependency graph ranks imported hub module #1 |
| 8 | `hierarchical-project-rules` | `project-rules` | Ordered root `AGENTS.md` -> subproject `CAUSYNE.md` -> `.causyne/rules/*.md` |
| 9 | `managed-background-task` | `background-task` | OS-sandboxed background process output streaming and clean exit 0 |
| 10 | `apply-patch-crlf-case-rename` | `multi-file-patch` | CRLF preservation and lossless case-only file rename (`widget.mjs` -> `Widget.mjs`) |
| 11 | `fs-edit-uniqueness-and-replace-all` | `refactor` | Ambiguous match rejection with hints followed by explicit `replace_all` |
| 12 | `causyneignore-enforcement` | `security` | `.causyneignore` blocking + `!negation` descent across read, search, and repo map |
| 13 | `audit-hash-chain-tamper-detection` | `governance` | SHA-256 hash chain passes clean and detects single-byte tampering |
| 14 | `hierarchical-enterprise-policy-layering` | `governance` | Managed `deny` overrides lower-precedence workspace `allow` |
| 15 | `multi-language-repomap-edges` | `repo-map` | Python relative import resolution and hub centrality ranking |

Observed scorecard: **15/15 (100.0%)** in ~2.2 seconds on macOS arm64 (Node.js 24).

## 2. Live Zero-API-Key (`$0`) End-to-End Measurements

Evaluated on Apple M1 (16 GiB unified memory, macOS, `workspace-write` Seatbelt
sandbox) using the real `bin/causyne.js -p ... --output-format json` CLI against
isolated Git repositories with held-out grading tests:

| Runtime | Cost Tier | Task | Outcome | Observed Metrics |
| --- | --- | --- | --- | --- |
| `acp/opencode` (`opencode/deepseek-v4.1-flash-free`) | `$0` free ACP peer | T1: TTL-LRU cache + single-flight concurrency | **PASS** (visible + hidden tests) | 27.0s, 5 steps, 5 tool calls, 0 tool errors, `$0.00` |
| `acp/opencode` (`opencode/deepseek-v4.1-flash-free`) | `$0` free ACP peer | T2: 4-file integer-cents billing refactor | Partial (visible pass, hidden edge-case fail) | 53.1s, 12 steps, 12 tool calls (`fs_read` x6, `fs_edit` x4, `sysRun` x2), 0 tool errors, `$0.00` |
| `antigravity` (`Gemini 3.8 Flash (Low)`) | Local CLI peer | T1: TTL-LRU cache + single-flight concurrency | **PASS** (visible + hidden tests) | 94.6s, 6 steps, 6 tool calls, 0 tool errors |
| `ollama` (`qwen2.5:14b`) | `$0` 100% offline | VRAM-adaptive `num_ctx` profiling | GPU offload fixed | Reduced projected VRAM from 14,504 MiB (37/49 layers, load timeout) to 9,793 MiB (**49/49 layers on GPU**, **99.4% KV cache reuse** across turns) |
| `ollama` (`llama3.1:8b`) | `$0` 100% offline | Compact local prompt profiling | Native tool call verified | Turn-1 prompt cut **49.7%** (`5,487 -> 2,758` tokens), cold prompt eval `70.8s -> 33.9s`, cached Turn-2 prompt eval `4.9s` (`33/33` GPU layers, `$0.00`) |

## 3. Honest Limitations

- Local 8B–14B quantized models on 16 GiB consumer machines run at ~4–8 output
  tokens/sec and can miss subtle multi-file constraints or emit malformed tool
  arguments compared to larger cloud models.
- Free cloud tiers (`openrouter/free`, Groq Free, Cerebras Free, Google AI
  Studio Free, Mistral Free) remain subject to upstream provider rate limits;
  `src/zeroCostFailover.ts` handles strict `$0`-only failover across configured
  free tiers and local Ollama without touching paid BYOK credentials.
