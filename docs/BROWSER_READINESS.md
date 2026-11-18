# Browser readiness and verification evidence

This page is a verification checklist, **not** an enterprise certification. The
tests below are executable in CI without using paid model APIs or actual user
accounts. A green CI run establishes only the tested behavior on that commit.

## Automated verification (GitHub Actions CI)

| Gate | Executable evidence | Scope |
| --- | --- | --- |
| Playwright actionability | `scripts/verify-browser-runtime.mjs` | DOM click, intercepted overlay, accessible snapshots, screenshots, explicit local navigation |
| Authenticated isolation | `scripts/verify-browser-auth-isolation.mjs` | Two separate browser profiles, cookies, concurrent operations, restart |
| Browser lifecycle soak | `scripts/verify-browser-soak.mjs` | Repeated workspaces/navigation/clicks, temporary tab churn, restart, local-origin isolation, RSS limits |
| Agent/tool integration | `scripts/verify-browser-agent-loop.mjs` | Real Chromium through a **simulated** provider tool call and the real agent-loop dispatcher |
| General host and provider unit tests | `npm test` | Mocked API wire formats, tool schemas, lifecycle recovery, sandbox policy |
| Build and type verification | `npm run build`, `npm run typecheck:strict` | Generated JavaScript and TypeScript contracts |

All `scripts/verify-browser-*.mjs` above require a system Chromium/Chrome
executable and `playwright-core`. CI installs the test-only Playwright driver.
Production browsers may use a different runtime (e.g. Camoufox); this smoke
coverage must **not** be represented as testing that production engine.

The soak script records `completed`, `requests`, `elapsed_ms`,
`node_peak_rss_mib`, `tree_peak_rss_mib`, `tree_peak_pss_mib`, and `peak_processes`.
The process-tree metrics use Linux `/proc`: total RSS is diagnostic and
can double-count shared pages, while the enforceable budget uses proportional
set size (PSS) from `smaps_rollup`. Neither replaces kernel OOM monitoring.

## Optional extended soak

Use **Actions → Extended browser soak (manual) → Run workflow**.

The workflow defaults to 500 repeated cycles per workspace and 4 concurrent
workspaces. It is manual to avoid recurrent GitHub Actions usage. A completed
manual workflow run is required before claiming long-duration endurance
coverage. Record the run URL, commit SHA, iteration count, peak memory, browser
version, and any failures.

Environment knobs for local execution:

- `CAUSYNE_BROWSER_EXECUTABLE`: absolute path of the executable
- `CAUSYNE_BROWSER_SOAK_ITERATIONS`: integer 1–10000
- `CAUSYNE_BROWSER_SOAK_WORKSPACES`: integer 1–8
- `CAUSYNE_BROWSER_SOAK_RSS_LIMIT_MIB`: Node.js process RSS ceiling
- `CAUSYNE_BROWSER_SOAK_TREE_PSS_LIMIT_MIB`: Linux process-tree PSS ceiling

## Remaining certification gates

1. **Live LLM providers:** Test real responses through every supported provider
   and model family with explicit user-owned API credentials, spending caps,
   consent, rate-limit/error injection, and request/response trace redaction.
   Mocked provider-conformance tests are *not* live tests.
2. **Production engine and operating systems:** Exercise the deployed Camoufox
   / Chromium runtime on Linux, macOS, and Windows. Current real-browser smoke
   runs only on Linux system Chrome/Chromium.
3. **Authentication:** Exercise real OAuth/login, MFA/manual handoff,
   session expiration, revoked tokens, and credential rotation without writing
   secrets into CI logs.
4. **Resource endurance:** Complete and archive an extended soak, alongside
   FD/process/CPU and disk-growth monitoring, crash recovery, and OOM pressure.
5. **Hostile web content and networking:** Security-review redirects, iframes,
   file access, downloads/uploads, service workers, prompt injection, and DNS
   rebinding. DNS validation followed by a separately resolved browser request
   does not by itself prove connection-level DNS pinning.
6. **Access controls:** Verify explicit user permission, workspace/profile
   isolation, and storage permissions on real host machines.

Do not use `bug-free`, `enterprise certified`, or `production certified`
until those release gates are independently evaluated and documented.
