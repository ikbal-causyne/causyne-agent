export const VERIFICATION_SKILLS = Object.freeze({
  'runtime-verification': {
    name: 'runtime-verification',
    description: 'Drive a real app or CLI and collect repeatable evidence. Use after UI, CLI, browser, or desktop changes before claiming completion.',
    content: `# Runtime verification
1. Identify one user-visible behavior and the actual launch command in the active workspace. Do not assume the Causyne repository is the workspace.
2. Run the build and existing tests first. Launch the real binary or local app using sysRun and the current workspace scope.
3. For a CLI, supply a real input and inspect the exit status and output. For a TUI, use an actual PTY and check emitted input/output; ordinary pipes do not establish terminal mouse or rendering behavior.
4. For a web app, use browser_act for navigation, snapshot, and screenshot. For a desktop app, use computer_use and explicit screenshot/inspection tools. Do not invent an "app aria-click" command.
5. Record the action, observed result, expected result, and artifact location. A screenshot alone does not prove the action took place. If an adapter or approval is unavailable, report unverified.
6. Close the launched process, and ensure transient resources are released.
## Verification
- Done when: the real user path was exercised, the assertion matched observed evidence, and cleanup succeeded. Build-only passes must be labeled build-only.`
  },
  'formal-verification': {
    name: 'formal-verification',
    description: 'Check state-machine invariants, retries, and asynchronous races. Use when tests do not cover all important event orders.',
    content: `# Formal verification
1. Choose a concrete safety property from code and identify the production transition functions. Model only states and actions supported by the implementation.
2. For small finite state spaces, run exhaustive bounded exploration on the production transition function. Record the depth, explored states, and assumptions.
3. For cross-process interleavings, use an installed TLA+ TLC checker with a version-pinned model. For unbounded data properties, consider an installed Lean verifier. Never silently download a binary or assume Lean is installed.
4. Run a deliberately broken variant in a scratch workspace to prove the invariant detects the bug. Restore the original and rerun.
5. Present the shortest counterexample as real actions. Never call bounded model exploration an unbounded proof or imply a TLA+ model proves the TypeScript implementation.
## Verification
- Done when: the check was actually executed, catches a deliberately failing case, and passes or reports a reproducible counterexample on unchanged production code.`
  },
  'ui-property-testing': {
    name: 'ui-property-testing',
    description: 'Explore UI state and input sequences including long random-looking text, resize, and session changes. Use for regressions in chat or navigation.',
    content: `# UI property testing
1. Define user-observable invariants for the current interface: text stays within viewport width, hover cannot mutate messages, Escape closes only the intended layer, and scrolling never escapes the active surface.
2. Generate deterministic seeded sequences of typed input, resize, mouse wheel, focus, Enter, and Escape, respecting real event decoding and lifecycle constraints.
3. Execute the real UI reducer or input handler for each sequence; use a PTY for claims about terminal behavior and browser_act for browser visuals.
4. Save the shortest failing sequence and seed. Rerun the original sequence after a fix; do not lower the assertion to make it pass.
## Verification
- Done when: the failing path was reproduced and is now a regression test, or the bounded sequence count and unverified host dependencies were reported.`
  },
  'statechart-verification': {
    name: 'statechart-verification',
    description: 'Explain and validate reachable states for queues, approvals, retries, and UI overlays. Use for state-dependent behavior with invalid transitions.',
    content: `# Statechart verification
1. Locate the real reducer or transition map. List states, events, guards, and actions from code.
2. Define forbidden states and transitions. Use bounded breadth-first exploration to reach every modeled state within the chosen bounds.
3. Where installed, confirm a TLA+ model with TLC. Draw a statechart only after checking the model, and label assumed or omitted transitions.
4. Report shortest paths to violations; do not invent events or conflate a diagram with an executable verification result.
## Verification
- Done when: each displayed transition has a code mapping and all reported counterexamples reproduce under the stated conditions.`
  },
  'verification-maintenance': {
    name: 'verification-maintenance',
    description: 'Update runtime and formal checks after touched code changes. Use when prior passing evidence may no longer describe the current implementation.',
    content: `# Verification maintenance
1. Compare changed source files against tests, runtime evidence and model-covered functions.
2. Invalidate prior evidence after behavior-changing edits. Reproduce the user path again, rather than reusing old screenshots, status flags, or test output.
3. Execute affected tests, build, and the appropriate runtime or bounded formal checks; distinguish missing tools from successful checks.
4. Preserve user scope, existing permissions, and unrelated files. Do not generate public documentation or commit private run reports.
## Verification
- Done when: all relevant checks were rerun against the present commit and missing validation is clearly marked, not silently treated as success.`
  }
});
