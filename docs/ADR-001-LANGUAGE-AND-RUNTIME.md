# ADR 001: orchestration language and runtime

Status: accepted direction, updated 2026-10-19; migration not yet complete.

Use Node.js for the desktop harness and migrate incrementally from JavaScript
to strict TypeScript. The provider/tool ecosystem and current asynchronous
orchestration fit this runtime. Static types improve contracts and refactoring;
they do not validate untrusted model output or enforce runtime permissions.

Start with shared tool/event/provider/config types and runtime validators at
I/O boundaries, then migrate small modules while preserving tests. Avoid a
wholesale rewrite that discards behavior without equivalent verification.

Use Rust only for a measured performance bottleneck or a narrow native/privilege
boundary with an explicit protocol, cancellation and resource limits. Rust's
memory safety does not automatically make command authorization correct.

Distribution now uses readable ESM source; the old V8 bytecode requirement is
superseded. The current compiler configuration checks JavaScript, and
`typecheck:strict` covers four modules without enabling full strict mode.
