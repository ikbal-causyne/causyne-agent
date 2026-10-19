# Optional local capabilities

Standard sessions and fact/sliding-window memory do not require the Cortex
native stack. If Cortex is unavailable, the CLI should report that honestly.

The former Cortex provisioner silently installed `better-sqlite3` and
`@xenova/transformers` at initialization. That installation path has been removed.
Its pinned versions were 12.11.1 and 2.17.2, with protobufjs 7.6.5 and sharp
0.35.3 overrides. These are historical inventory values, not a recommendation
that the graph is currently vulnerability-free. The prior isolated graph had
unresolved audit findings and needs fresh review.

To enable Cortex in future setup work: resolve and audit an explicit manifest
and lockfile, review native installation scripts, install by the user's explicit
action into `$CAUSYNE_HOME/cortex` (default `~/.causyne/cortex`), and provision
the embedding model locally under the models directory. The runtime checks for
installed modules and uses local-only model loading; it performs no download.
Do not copy old credentials or enable it just to make test skips disappear.

Other groups in `src/provisioning/capabilityProvisioner.js` are individually
granted. Their runtime installation surface remains review work, including
engine setup in `tools/manageLocalAiDependencies.js`. No general claim of
zero network or zero package installation is made for user-invoked setup tools.
