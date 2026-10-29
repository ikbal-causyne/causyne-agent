# Current architecture

Decision: 2026-10-19. Causyne Agent is an independent local desktop CLI.

```text
local terminal -> entrypoint -> cliMode / local approval UI
                                  |
                              agentLoop
                                  |
              provider adapters <-> plan / act / observe / reflect
                                  |
             policy + workspace checks + approvals + tool registry
                                  |
                 local processes / files / desktop applications
                                  |
                  observations, memory, sessions, checkpoints
```

The LLM may be a configured remote API, a local model endpoint, or an installed
ACP peer agent. Web tools and third-party MCP servers may use the network.
Neither makes the program a phone-controlled daemon, nor makes every workflow
offline. Provider keys are stored locally and sent to the chosen provider for
authentication.

Peer agents (OpenCode, Claude Code, Codex, Gemini CLI, Cursor, Antigravity) are
providers in the same sense as an HTTP API, addressed as `acp/<peer>`: the
user's existing CLI login is the credential, the peer's own `models` command
supplies the catalogue, and the session is billed by that subscription — Causyne
cannot determine the monetary cost when the peer does not expose its invoice.

Causyne Agent is engineered for billions of users globally across diverse engineering
ecosystems. Universal ACP capability preservation is mandatory: provider bridges and
ACP adapters must NEVER destroy, strip, or degrade ACP capabilities, MCP tool inheritance,
or peer execution environments. Peer agents are never locked into artificial
"transport verification only" or tool-less sandboxes.

The Antigravity CLI adapter uses a Causyne-managed profile in private adapter state
and carries the actual host workspace in its prompt. It preserves MCP inheritance and
native tooling capabilities while emitting Causyne tool requests (`<tool_call>`).
Host execution and approvals remain in `AgentLoop`, and any native peer tool calls
are seamlessly mapped to Causyne host execution. It does not force the peer's plan mode
or modify global peer settings. Session token counters, cache-read counters, and unknown
monetary cost are reported separately.

`LocalCLIConnection` is a local rendering/event adapter, not an inbound network
connection. `emitEvent` feeds the terminal. Tools can execute host commands;
the harness is not an OS isolation boundary. Autonomy modes and sandbox rules
are application policies and require adversarial review.

## Modules

| Concern | Source |
| --- | --- |
| Invocation and local session | `entrypoint.js`, `cliMode.js`, `tui/` |
| Orchestration and budgets | `agentLoop.js`, `decisionPolicy.ts`, `implementationPlan.ts`, `agentProfiles.ts`, `subagentJournal.ts`, `modelRouter.js`, `tokenTracker.js` |
| Host execution | `tools/registry.js`, `sandbox.js`, `execSafe.js` |
| Models | `providers/`, `modelCatalogue.js` |
| Context and memory | `memory.js`, `memoryManager.js`, `contextManager.js`, `cortex/` |
| Recovery | `checkpoints.js`, `gitSnapshot.js`, `sessionJournal.ts`, `sessionStore.js` |
| Extensions | `mcp/`, `plugins/`, `hooks.ts`, `skillsManager.js`, `toolPacks.js` |
| Readable interpreter source | `src/tool-scripts/` |

The shipping runtime is ESM on Node.js 24+. Incremental strict TypeScript
migration is active: `tsconfig.runtime.json` emits readable JavaScript beside
strict TypeScript runtime modules, shared contracts live under `src/types/`,
and retained JavaScript has a separately named migration ratchet. Session,
plugin-skill, task-shape, delegated-agent, hook, approval-grant, plan-cache and
MCP boundaries now compile from strict TypeScript.
Runtime validation is still required at model, filesystem, subprocess and
extension boundaries. Rust is reserved for a measured, narrow native worker;
no Rust rewrite is underway.

## Planning and durable decisions

Complex implementation uses `update_plan` to maintain a validated checklist in
session state. The TUI keeps the current steps visible beside the input surface;
plans are not written into the user's project. A mutating tool call on a complex
task is held until the model has created this plan.

`request_decision` handles choices with durable product, architecture, data,
security, or workflow consequences. It presents two to four concrete options
and a custom-answer path. This checkpoint is distinct from a tool permission:
selecting a design never grants filesystem or command access. The checkpoint
runs in the provider-independent agent loop, so Mode C can remove routine
approval friction without silently choosing an unresolved architecture.

## Tool and extension boundaries

Tool schemas are assembled once from native tools, explicitly enabled plugins,
and granted MCP servers. Denied tools are removed before the model sees them,
native names win collisions, and large capability groups remain deferred until
the task shape or `tool_search` makes them relevant.

Local plugins use a static `plugin.json` manifest. Creating a plugin leaves it
disabled. Enabling it pins a digest of every file the plugin process may read;
any later manifest, source, helper or asset change revokes trust. Discovery
validates static manifests and hashes bytes without importing JavaScript, so
code cannot run during pre-trust initialization. Reviewed plugins may contribute
namespaced, progressively disclosed Markdown skills; these remain inert data
and disappear from the catalogue if the digest changes. A plugin tool runs in a
separate Node process with the permission model enabled and only its declared
workspace, network, or subprocess capabilities. Plugin calls still pass through
Causyne's sandbox and approval gates.

MCP uses the official Model Context Protocol client packages rather than a
project-specific JSON-RPC implementation. It supports local stdio servers and
remote Streamable HTTP servers, with legacy SSE fallback when configured for
automatic negotiation. The SDK owns initialization, capability negotiation,
protocol framing, request cancellation, and transport shutdown. Causyne adds
connection timeouts, bounded output, current-workspace roots, concurrent
discovery, `tools/list_changed` refresh, structured content handling, and
namespaced access to server resources and prompts.

Each MCP grant is bound to a SHA-256 digest of the complete server definition.
Changing a command, URL, environment, header, working directory, timeout,
protocol mode, or tool filter invalidates the old grant. Disconnect and revoke
also invalidate an in-flight handshake so a stale connection cannot become
active afterward. Per-server include and exclude patterns limit which
capabilities enter the model's catalogue. Connection state distinguishes
disabled, connecting, connected, failed, and authentication-required servers;
one failing server does not prevent native tools or other MCP servers from
loading. Static bearer or custom headers may be configured locally. Interactive
browser OAuth is not implemented yet; an HTTP 401 is surfaced as
`needs_auth` instead of being reported as a generic transport failure.

## Agent browser boundary

Causyne's web foundation has two layers. Lightweight TypeScript search and
fetch clients work without a browser runtime. Rendered navigation uses a
dedicated in-process Causyne Browser adapter built from a locally reviewed
upstream browser engine. Required upstream names and licenses remain in the
third-party notices. The adapter is deliberately smaller than the reference
service:
it does not import an HTTP server, inbound port, cloud deployment layer, VNC,
telemetry, remote WebSocket control, or OpenClaw integration.

The browser engine and Playwright are exact-pinned optional capability packages
installed into the user's private Causyne capability directory only after an
explicit browser capability grant. Causyne does not download a browser binary. Advanced
rendered browsing requires a separately installed supported browser runtime
selected by `CAUSYNE_BROWSER_EXECUTABLE` or discovered from a standard system
location.
The main npm package therefore stays small and web search remains useful when
the optional rendered browser is absent.

The browser runs headless by default with WebRTC blocked and a Causyne-owned
profile. It provides tabs, navigation, accessibility snapshots with bounded
pagination, stable element references, form interaction, bounded extraction,
and atomic downloads restricted to the selected workspace. Search first uses
bounded DuckDuckGo HTML and Bing RSS providers, then uses rendered provider
pages when the optional browser is available. Failures remain visible after
every provider is exhausted instead of being replaced with fabricated results.

Every top-level navigation and browser subresource passes through the public
URL policy. The policy accepts only HTTP(S), rejects embedded credentials,
resolves hostnames before access, and blocks loopback, private, link-local,
multicast, reserved, local, internal, and metadata addresses. Redirects in the
non-browser fetch path are revalidated one at a time. Responses and extracted
text are bounded, and network downloads require the existing approval gate.
These controls reduce SSRF and unbounded-output risk while preserving normal
public-web use from the user's selected workspace.

User-defined subagent profiles are static JSON manifests under the local Causyne
state directory. A profile supplies bounded instructions, an allowlist of tools,
and hard step/token ceilings. It cannot widen its own scope, cannot recursively
delegate, and does not load executable project code. Calls may narrow a
profile's tool scope or budgets, but cannot exceed them.

Completed delegated runs write a separate append-only JSONL sidechain under the
local Causyne state directory. The parent receives only the worker's final
result, while the bounded sidechain retains its messages and outcome for local
inspection. A torn final append preserves earlier complete events.

Hooks are user-owned argv arrays stored in the local Causyne configuration.
They never pass through a shell and project repositories are not searched for
startup hooks. `PreToolUse` runs after the built-in sandbox and before an
approval prompt; exit code 2 denies, and any other failure fails closed.
`PostToolUse` can annotate a result or reject it without rewriting history.

Host execution remains the current architecture because Causyne must operate in
the directory and desktop environment the user selected. Container work is
deferred and is not part of the present implementation plan.

## Durable sessions

Each workspace-scoped conversation is stored as an append-only JSONL event
journal. Reads project `session.created`, `messages.appended`,
`messages.windowed`, and explicit replacement events into the current session.
A torn final append preserves prior complete events, while complete corruption
fails safely. Legacy per-session JSON and global history files migrate on read.
The compatibility `sessionStore.js` entry keeps existing callers stable while
the strict TypeScript journal emits the JavaScript used at runtime.

## Plan cache and context pressure

Completed multi-step runs teach argument-free plan templates. Lookup tries an
indexed exact signature first, then bounded lexical similarity only for a task
shape with enough confidence. Latency, hit type and recent hit rate are recorded;
lookup temporarily cools down when a populated cache repeatedly misses while
new successful plans may continue warming it. Persisted plans and metrics are
validated before entering the typed runtime; malformed entries are ignored.
`/plans import` accepts sanitized
offline samples for known workloads, and `/plans` exposes the measurements.
`npm run benchmark:plan-cache` measures exact lookup, fuzzy lookup, misses and
prewarming at bounded cache sizes in an isolated temporary state directory. It
is a synthetic cache microbenchmark, not evidence for model accuracy, token
cost, or end-to-end latency claims from the research paper.

Context uses per-tool result budgets, oversized-result snipping, decay, a bounded
sliding window, and structural summaries. Full tool output is spilled before it
is shortened. Material compaction is recorded in the audit log, and summary
collapse emits a quiet terminal notice so context loss is visible.

## Guided setup and creative applications

`causyne setup` (also `causyne config`), `/setup` and the home setup menu share
one TypeScript configuration transaction. Provider, endpoint, model, credentials
and autonomy choices are reviewed before saving. Cancellation preserves the
previous configuration. Credentials are not reused across providers or changed
custom endpoints. Setup validates input locally; it does not claim provider
connectivity or make a billable model request.

The deferred `creative_apps` tool exposes installed-application status and native
automation adapters for 3D and media creative applications. The file-based Blender batch
adapter creates and manipulates 3D primitives (cubes, spheres, cylinders, planes, cameras,
lights, materials, rendering) and saves a new `.blend` scene file without running model-supplied
arbitrary code. Native ExtendScript adapters connect Photo Studio (image resizing,
rotations, layer modifications, flattening to PSD/PNG/JPG/WEBP), Video Studio (sequence
timelines, media import, markers, cuts to PRPROJ/XML), and Motion Studio (compositions,
footage import, typography to AEP). It validates workspace paths, refuses overwrites,
and applies timeout, output, and cancellation limits. No inbound control service or expensive
remote protocols are opened.

## Removed boundaries

No active pairing, relay, WebRTC/P2P, mobile command surface, background daemon
lifecycle, V8 bytecode loader or Android import. Socket editor clients have no
active network implementation; their methods report held status or use CLI
fallbacks. Local process automation without an inbound command server remains.

Remote capability is on hold. Its old architecture is retired permanently.
Future GUI and remote work need distinct decisions and threat models.

## Distribution

The launcher imports the shipped source directly. `npm run build` regenerates
readable skill data only. No minifier, bytecode compiler or self-updater runs.
An npm allowlist includes source and security/provenance documents; private
archives live outside this repository. The unpublished manifest is private.
The independent repository does not import the Android repository history.
