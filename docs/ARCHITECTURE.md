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

The LLM may be a configured remote API or a local model endpoint. Web tools
and third-party MCP servers may use the network. Neither makes the program
a phone-controlled daemon, nor makes every workflow offline. Provider keys
are stored locally and sent to the chosen provider for authentication.

`LocalCLIConnection` is a local rendering/event adapter, not an inbound network
connection. `emitEvent` feeds the terminal. Tools can execute host commands;
the harness is not an OS isolation boundary. Autonomy modes and sandbox rules
are application policies and require adversarial review.

## Modules

| Concern | Source |
| --- | --- |
| Invocation and local session | `entrypoint.js`, `cliMode.js`, `tui/` |
| Orchestration and budgets | `agentLoop.js`, `modelRouter.js`, `tokenTracker.js` |
| Host execution | `tools/registry.js`, `sandbox.js`, `execSafe.js` |
| Models | `providers/`, `modelCatalogue.js` |
| Context and memory | `memory.js`, `memoryManager.js`, `contextManager.js`, `cortex/` |
| Recovery | `checkpoints.js`, `gitSnapshot.js`, `sessionStore.js` |
| Extensions | `mcp/`, `plugins/`, `hooks.js`, `skillsManager.js`, `toolPacks.js` |
| Readable interpreter source | `src/tool-scripts/` |

The current implementation remains JavaScript/ESM on Node.js 24+. The accepted
language direction is incremental strict TypeScript. Runtime validation is
still needed at model, filesystem, subprocess and extension boundaries.
Rust is a possible narrow native worker later; no Rust rewrite is underway.

## Tool and extension boundaries

Tool schemas are assembled once from native tools, explicitly enabled plugins,
and granted MCP servers. Denied tools are removed before the model sees them,
native names win collisions, and large capability groups remain deferred until
the task shape or `tool_search` makes them relevant.

Local plugins use a static `plugin.json` manifest. Creating a plugin leaves it
disabled. Enabling it pins a digest of every file the plugin process may read;
any later manifest, source, helper or asset change revokes trust. Discovery
validates static manifests and hashes bytes without importing JavaScript, so code cannot run
during pre-trust initialization. A plugin tool runs in a separate Node process
with the permission model enabled and only its declared workspace, network, or
subprocess capabilities. Plugin calls still pass through Causyne's sandbox and
approval gates.

Hooks are user-owned argv arrays stored in the local Causyne configuration.
They never pass through a shell and project repositories are not searched for
startup hooks. `PreToolUse` runs after the built-in sandbox and before an
approval prompt; exit code 2 denies, and any other failure fails closed.
`PostToolUse` can annotate a result or reject it without rewriting history.

Host execution remains the default because Causyne must work in the directory
the user selected. Optional container isolation can be added as an execution
profile later, but it must remain explicit: mounting a workspace into Docker is
a different trust boundary and cannot silently replace native desktop access.

## Plan cache and context pressure

Completed multi-step runs teach argument-free plan templates. Lookup tries an
indexed exact signature first, then bounded lexical similarity only for a task
shape with enough confidence. Latency, hit type and recent hit rate are recorded;
lookup temporarily cools down when a populated cache repeatedly misses while
new successful plans may continue warming it. `/plans import` accepts sanitized
offline samples for known workloads, and `/plans` exposes the measurements.
`npm run benchmark:plan-cache` measures exact lookup, fuzzy lookup, misses and
prewarming at bounded cache sizes in an isolated temporary state directory. It
is a synthetic cache microbenchmark, not evidence for model accuracy, token
cost, or end-to-end latency claims from the research paper.

Context uses per-tool result budgets, oversized-result snipping, decay, a bounded
sliding window, and structural summaries. Full tool output is spilled before it
is shortened. Material compaction is recorded in the audit log, and summary
collapse emits a quiet terminal notice so context loss is visible.

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
