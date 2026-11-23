# Security review and migration status

Review date: 2026-11-23. This is a scoped source and package review, not a
claim that Causyne Agent is free from vulnerabilities.

## OpenSSF records

The legacy packages have two distinct OpenSSF records:

- `MAL-2026-13397` names `@vanexalabs-ai/vanexa-agent` versions 1.3.50 through
  1.3.62. OpenSSF's current record marks this advisory **withdrawn** as of
  2026-08-25, and the repository moved it from `osv/malicious` to
  `osv/withdrawn` in merged pull request 1473.
- `MAL-2026-13364` names `@ikbal_fadilah_vanexa01/vanexa-agent` versions in the
  published 1.1.51 through 1.3.45 set. Its current OpenSSF record remains under
  `osv/malicious`; no withdrawal was found during this review.

The dispute issue remains open. The withdrawn status of one advisory does not
withdraw the other or prove that every historical release was safe.

Sources: [dispute issue 1470](https://github.com/ossf/malicious-packages/issues/1470),
[withdrawn MAL-2026-13397 record](https://github.com/ossf/malicious-packages/blob/main/osv/withdrawn/npm/%40vanexalabs-ai/vanexa-agent/MAL-2026-13397.json),
[active MAL-2026-13364 record](https://github.com/ossf/malicious-packages/blob/main/osv/malicious/npm/%40ikbal_fadilah_vanexa01/vanexa-agent/MAL-2026-13364.json),
and [withdrawal pull request 1473](https://github.com/ossf/malicious-packages/pull/1473).

## Historical package evidence

The npm tarballs were fetched with lifecycle scripts disabled and inspected
locally. Their SHA-256 hashes provide a reproducible identity for this review:

| Package | Version | Tarball SHA-256 | Material finding |
| --- | ---: | --- | --- |
| `vanexa-agent` | 1.1.48 | `57b933623759f88719d8ed8dce5e841f76ff6b576f8a30f227bb28bdabcdbd3e` | Included install scripts and a `postinstall` hook that compiled a readable bundle to V8 bytecode. This package is not named by the two records above, but it did execute code during installation. |
| `@ikbal_fadilah_vanexa01/vanexa-agent` | 1.3.45 | `69501eb9af623472b8e551cfeef98dd2ceacce32a5e8a14b01b2fb8631d8516d` | Included readable bundled source and bytecode, plus `werift`, `ws`, and host-execution dependencies. It had no npm install lifecycle hook in this tarball. |
| `@vanexalabs-ai/vanexa-agent` | 1.3.62 | `aaf0b65621a9b4d3579cbf31bbb07610efe67e3e2c65a1e414ef49ee6cd46d86` | Shipped bytecode without readable runtime source. Its Socket policy ignored broad malware, obfuscation, shell, filesystem, network, native-code, and install-script categories. |
| `@vanexalabs-ai/vanexa-agent` | 1.9.19 | `6491307e8d8ae253a3f97514f079fa00b4b8607606cfd9dd53fe0f7cc55adc38` | Still shipped a bytecode-only runtime with `bytenode` and `ws`; the inspected manifest had no npm install lifecycle hook. This version is outside MAL-2026-13397's affected set. |

The reports describe a phone-paired daemon that accepted commands over remote
signaling or data channels and dispatched them to host execution. The preserved
legacy source contains that architecture, relay endpoints, daemon lifecycle,
pairing, WebRTC code, bytecode build logic, and deliberate string-obfuscation
steps. Those facts explain why the old package shape attracted remote-access
and concealment concerns even where the intended use was consensual.

## Current Causyne package

The active source takes a different architecture and distribution path:

- It is a foreground local CLI. Pairing, phone control, relays, WebRTC/P2P,
  background daemon lifecycle, and remote headless command intake are absent.
- `bytenode`, `werift`, and `ws` are not production dependencies. The package
  ships readable source compiled from strict TypeScript and has no npm
  `install`, `postinstall`, or `prepare` lifecycle scripts. For managed global
  npm / installer distributions, `bin/causyne.js` invokes a background update
  check against the official npm registry (`@causyne/agent`) that enforces HTTPS
  on `registry.npmjs.org`, SRI digest validation, Sigstore provenance checks,
  and `--ignore-scripts`; source checkouts are never rewritten, and automatic
  checks can be disabled with `CAUSYNE_DISABLE_AUTOUPDATE=1`.
- Process sandboxing (`src/tools/osSandbox.ts`) defaults to `workspace-write`
  (macOS Seatbelt / Linux Bubblewrap) for both stateless (`sysRun`) and
  persistent (`terminal.persistent_shell`) shell execution, with credential-path
  denials and explicit opt-out via `CAUSYNE_OS_SANDBOX=off`.
- Credential custody (`src/osKeychain.ts`, `src/configVault.ts`) defaults to
  `auto` OS keychain protection on interactive desktops (macOS Keychain via
  stdin, Linux Secret Service via stdin, Windows DPAPI) with mode-`0600`
  AES-256-GCM encrypted fallback and `off` default in CI/test runners.
- Enterprise governance (`src/enterprisePolicy.ts`, `src/auditLog.ts`,
  `src/ignoreRules.ts`, `src/hooks.ts`) provides fail-closed hierarchical
  additive `managed -> user -> workspace` `causyne.policy.json` enforcement
  (`allow`/`ask`/`deny` rules for tools, commands, paths, domains, and MCP
  servers across direct tool calls, read-only prefetch, `apply_patch`, `task_bg`,
  and peer operations), `.causyneignore` workspace file exclusion with
  `!negation` support, linear-time secret-redacted lifecycle hooks, and a
  tamper-evident SHA-256 hash-chained audit log (`causyne audit verify`,
  `causyne audit prune`, `causyne audit export --format jsonl|csv|ocsf`) with
  OCSF v1.1.0 SIEM output, secret redaction, and CSV formula-injection
  neutralization.
- Cross-platform path and process hardening (`src/utils/winSpawn.ts`,
  `src/agent/workspaceBoundary.ts`, `src/infra/atomicWriter.ts`,
  `src/tools/archive.ts`, `src/mcp/mcpClient.ts`, `src/mcp/mcpRegistry.ts`)
  eliminates `shell: true` on Windows `.cmd`/`.bat` shims by unwrapping Node
  shims directly, strips Windows `\\?\` extended-length prefixes with
  case-insensitive containment checks, uses `O_EXCL` + `fsync` + retry-backoff
  atomic writes, blocks Zip-Slip and symlink compression in archives, enforces
  HTTPS on non-loopback MCP servers with credential headers, and preserves full
  ACP peer capabilities without injecting restrictive profiles.
- Automatic Cortex dependency installation is disabled. Optional capability
  packages use a fixed version allowlist, require an approval-class capability
  grant, install into local Causyne state, and use `npm install --ignore-scripts`.
- Arbitrary binary/model download actions were removed from the dependency
  manager. Missing engine checks no longer create a placeholder and report a
  false successful installation.
- Python package setup passes arguments without a shell and accepts exact PyPI
  pins only. URLs, VCS references, paths, options, and unpinned requirements are
  rejected.
- The Palmier adapter cannot install third-party applications, and the Astryx
  adapter no longer auto-installs a package through `npx --yes`.
- `web_fetch` downloads and curated game-asset downloads require the highest
  approval class. Curated assets are size-limited, constrained to catalog URLs,
  protected from output path traversal, and are not automatically extracted.
- Web search uses bounded HTTP providers without requiring a browser binary.
  Interactive rendered browsing uses an outbound, in-process Causyne Browser adapter.
  Causyne does not run an inbound browser-control server, inbound port, remote control,
  VNC, telemetry, cloud deployment, or OpenClaw integration. Optional launcher
  packages require an explicit capability grant. Causyne never downloads the
  browser runtime; an existing external installation must be selected
  through `CAUSYNE_BROWSER_EXECUTABLE` or a standard system location.
- Browser navigation and subresources accept only public HTTP(S) destinations.
  Hostnames are resolved and checked against private, loopback, link-local,
  multicast, reserved, local, internal, and metadata ranges. Non-browser
  redirects are checked at every hop. Downloads are bounded, atomic, restricted
  to the selected workspace, and remain in the highest approval class.
- The package allowlist excludes the legacy archive, Android source, private
  operating documents, credentials, installers, bytecode, and generated
  tarballs.

At review time, `npm audit --omit=dev` reported zero known vulnerabilities in
the active locked production graph. The lockfile contains 16 production
packages, no dependency lifecycle scripts were recorded in the lockfile, 100%
of `src/` modules (including generated product skills) are authored in and
compiled from strict TypeScript (`npm run typecheck:strict`) with zero unbacked
`.js` files, and GitHub CodeQL code scanning reports zero open alerts across
3-OS CI validation.

## Remaining risk

Causyne Agent is designed to operate on files, processes, applications, model
providers, and user-configured MCP servers. These capabilities can cause harm
when a request is wrong, approval is careless, a dependency is compromised, or
policy enforcement is bypassed. The application policy is not an operating
system security boundary.

The licensor confirmed on 2026-10-19 that the project-authored source, skills,
tests, and assets are original work or otherwise lawful to distribute. A
separate independent security review has not been completed. Optional
capability graphs must be audited when installed because they are outside the
main lockfile and can change after this review.
