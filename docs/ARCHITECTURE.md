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
| Extensions | `mcpClient.js`, `skillsManager.js`, `toolPacks.js`, user skills and Tool Forge |
| Readable interpreter source | `src/tool-scripts/` |

The current implementation remains JavaScript/ESM on Node.js 24+. The accepted
language direction is incremental strict TypeScript. Runtime validation is
still needed at model, filesystem, subprocess and extension boundaries.
Rust is a possible narrow native worker later; no Rust rewrite is underway.

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
