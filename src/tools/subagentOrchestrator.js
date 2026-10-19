import { TokenTracker } from '../tokenTracker.js';

// Subagent delegation.
//
// WHAT THIS USED TO DO (finding D-7)
//
// The previous implementation imported `fork` and `Worker` and used neither.
// It waited on a `setTimeout`, then returned:
//
//     "Subagent [X] successfully executed task: "..." within scope [...].
//      Zero errors detected."
//
// for work that had never happened. It pushed a "✅ Subagent Completed" push

// the tokens it pretended to spend. Worst of all, that sentence went straight
// into the parent model's context, so the model reasoned onward from a lie —
// and the schema described the whole thing as "surpasses standard CLI
// single-loop agents".
//
// A tool that reports success it did not earn is worse than a tool that does
// not exist: a missing tool fails loudly and the agent routes around it, while
// a lying tool corrupts every conclusion drawn after it.
//
// WHAT IT DOES NOW
//
// It runs a real AgentLoop. Each subagent gets its own message history, its own
// step ceiling, its own token accounting, and a tool scope that is actually
// enforced by the loop (agentLoop.js filters the catalogue against

// transport, tagged with its id. `delegate_and_wait` returns the child's real
// final message. When a subagent fails, this tool says so.
//
// The loops run in-process on purpose. Delegation and real concurrency come
// from several loops awaiting network I/O at once; forking a child process of
// our own binary would add a process-spawner pattern to the artefact for no
// capability we do not already have.

const activeSubagents = new Map();
const MAX_CONCURRENT_SUBAGENTS = 4;

// A subagent may never delegate again. The depth argument documents the rule;
// withholding the tool from the child's scope is what enforces it.
const SUBAGENT_TOOL_NAME = 'agent.subagent_orchestrate';
const DEFAULT_TOOL_SCOPE = ['fs_read', 'fs_find', 'fs_search', 'fs_list', 'code_search_ast'];


function childTransport(parentLoop, subagentId, name) {
  return {
    get readyState() {
      return parentLoop && parentLoop.eventSink ? parentLoop.eventSink.readyState : 3;
    },
    send(raw) {
      if (!parentLoop || typeof parentLoop.emitEvent !== 'function') return;
      let frame;
      try { frame = JSON.parse(raw); } catch (e) { return; }
      parentLoop.emitEvent({ ...frame, subagentId, subagentName: name });
    }
  };
}

async function executeSubagent(record, parentLoop) {
  // Imported lazily: agentLoop.js reaches this module through the tool
  // registry, so a static import would close a cycle.
  const { AgentLoop } = await import('../agentLoop.js');

  const transport = childTransport(parentLoop, record.subagentId, record.name);
  const child = new AgentLoop(transport, record.subagentId, record.prompt);

  // A delegated task is a bounded errand, not a second full session.
  child.maxSteps = Math.min(child.maxSteps || 25, record.maxSteps);
  child.maxCircuitBreaker = child.maxSteps;
  child.messages = [];
  child.toolScope = new Set(record.toolScope.filter(n => n !== SUBAGENT_TOOL_NAME));
  child.currentTaskPrompt = record.prompt;
  // Depth is carried so the child's own guard can refuse, even if a future
  // change ever puts the delegation tool back in scope.
  child.subagentDepth = record.depth;

  record.loop = child;
  record.startedAtMs = Date.now();

  await child.run();

  const finalAssistant = [...child.messages].reverse()
    .find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const toolCalls = child.messages.filter(m => m.role === 'tool');
  const failures = toolCalls.filter(m => {
    try { return JSON.parse(m.content).success === false; } catch (e) { return false; }
  });

  return {
    subagentId: record.subagentId,
    name: record.name,
    stepsCompleted: child.stepsCompleted,
    toolCallsMade: toolCalls.length,
    toolFailures: failures.length,
    elapsedMs: Date.now() - record.startedAtMs,
    // The child's own words, not a template. If it produced nothing, say that
    // rather than inventing a summary.
    summary: finalAssistant ? finalAssistant.content : null,
    stoppedEarly: child.stepsCompleted >= child.maxSteps
  };
}

export const subagentOrchestrator = {
  schema: {
    name: SUBAGENT_TOOL_NAME,
    description: 'Delegate a bounded sub-task to an independent agent loop with its own context, step budget and restricted tool scope. Use it to parallelise genuinely independent work (research several files, audit separate modules). The subagent runs a real agent loop and returns its actual result; it cannot delegate further.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'list', 'kill', 'delegate_and_wait'],
          description: 'spawn (start in the background and return immediately), list (show active subagents), kill (stop one), delegate_and_wait (run it and return the result).'
        },
        name: { type: 'string', description: 'A short name for the subagent, e.g. Audit_Worker.' },
        prompt: { type: 'string', description: 'The complete instruction for the subagent. It has no memory of this conversation, so it must be self-contained.' },
        subagentId: { type: 'string', description: 'Target subagent for the kill action.' },
        toolScope: { type: 'array', items: { type: 'string' }, description: 'Catalogue tool names the subagent may use. Defaults to read-only inspection tools. It can never receive the delegation tool itself.' },
        maxSteps: { type: 'integer', description: 'Step ceiling for the subagent. Defaults to 25.' },
        maxTokens: { type: 'integer', description: 'Advisory token budget for this subagent. Defaults to 50000.' },
        depth: { type: 'integer', description: 'Hierarchy depth. 0 = master, 1 = worker. Subagents cannot spawn subagents.' }
      },
      required: ['action']
    }
  },

  async execute(args, context = {}) {
    try {
      const action = args.action;
      const parentLoop = context.parentLoop || null;

      if (action === 'list') {
        const list = [...activeSubagents.values()].map(worker => ({
          subagentId: worker.subagentId,
          name: worker.name,
          status: worker.status,
          depth: worker.depth,
          toolScope: worker.toolScope,
          startTime: worker.startTime,
          stepsCompleted: worker.loop ? worker.loop.stepsCompleted : 0,
          summary: worker.summary,
          error: worker.error
        }));
        return {
          success: true,
          output: JSON.stringify({
            active_workers: list.filter(w => w.status === 'running').length,
            max_concurrent_allowed: MAX_CONCURRENT_SUBAGENTS,
            workers: list
          }, null, 2)
        };
      }

      if (action === 'kill') {
        const id = args.subagentId || args.name;
        if (!id) return { success: false, error: 'subagentId or name is required to stop a subagent.' };
        for (const [key, worker] of activeSubagents.entries()) {
          if (key === id || worker.name === id) {
            // Safe now that run() rearms the controller (Phase 2): aborting one
            // loop no longer poisons any other.
            try { if (worker.loop) worker.loop.abort(); } catch (e) {}
            worker.status = 'killed';
            activeSubagents.delete(key);
            return { success: true, output: `Subagent ${key} (${worker.name}) stopped.` };
          }
        }
        return { success: false, error: `Subagent ${id} not found.` };
      }

      if (action !== 'spawn' && action !== 'delegate_and_wait') {
        return { success: false, error: `Unknown action: ${action}` };
      }

      const prompt = args.prompt;
      if (!prompt) return { success: false, error: 'A prompt is required to delegate a task.' };

      const depth = args.depth !== undefined ? args.depth : 1;
      if (depth > 1) {
        return {
          success: false,
          error: `Subagent hierarchy depth violation: depth ${depth} exceeds the 2-tier boundary (master -> worker). Subagents cannot delegate further.`
        };
      }
      if (parentLoop && parentLoop.subagentDepth !== undefined) {
        return { success: false, error: 'A subagent cannot delegate to another subagent.' };
      }

      const running = [...activeSubagents.values()].filter(w => w.status === 'running').length;
      if (running >= MAX_CONCURRENT_SUBAGENTS) {
        return {
          success: false,
          error: `Subagent concurrency limit reached (${MAX_CONCURRENT_SUBAGENTS} running). Stop one, or wait for it to finish.`
        };
      }

      const name = args.name || `Worker_${Math.random().toString(36).slice(2, 7)}`;
      const subagentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const requestedScope = Array.isArray(args.toolScope) && args.toolScope.length > 0
        ? args.toolScope
        : DEFAULT_TOOL_SCOPE;

      // Reject an unknown tool name instead of silently accepting it. The old
      // implementation accepted anything, which is easy to do when the scope is
      // never used for anything.
      const { TOOL_DEFINITIONS } = await import('./registry.js');
      const catalogue = new Set(TOOL_DEFINITIONS.map(t => t.name));
      const unknown = requestedScope.filter(n => !catalogue.has(n) && n !== SUBAGENT_TOOL_NAME);
      if (unknown.length > 0) {
        return { success: false, error: `Unknown tools in toolScope: ${unknown.join(', ')}.` };
      }

      const record = {
        subagentId,
        name,
        prompt,
        toolScope: requestedScope,
        depth,
        maxSteps: args.maxSteps || 25,
        maxTokens: args.maxTokens || 50000,
        status: 'running',
        startTime: new Date().toISOString(),
        summary: null,
        error: null,
        loop: null
      };

      // Budget pre-check against the real tracker, before any work starts.
      const tracker = new TokenTracker();
      const estimated = Math.ceil(prompt.length / 4) + 1500;
      const check = await tracker.trackUsage(estimated, 0);
      if (!check.allowed) {
        return {
          success: false,
          error: `Token budget block: ${check.reason || 'the budget threshold would be exceeded by this subagent.'}`
        };
      }

      activeSubagents.set(subagentId, record);

      const work = executeSubagent(record, parentLoop)
        .then(result => {
          record.status = 'completed';
          record.summary = result.summary;
          return result;
        })
        .catch(error => {
          record.status = 'failed';
          record.error = error.message;
          throw error;
        });

      if (action === 'delegate_and_wait') {
        try {
          const result = await work;
          activeSubagents.delete(subagentId);
          // No summary means the subagent produced nothing. Report that
          // plainly — it is a real outcome, and pretending otherwise is the
          // exact defect this rewrite exists to remove.
          if (!result.summary) {
            return {
              success: false,
              error: `Subagent [${name}] finished without producing a result after ${result.stepsCompleted} steps.`,
              output: JSON.stringify(result, null, 2)
            };
          }
          return { success: true, output: JSON.stringify(result, null, 2) };
        } catch (error) {
          activeSubagents.delete(subagentId);
          return { success: false, error: `Subagent [${name}] failed: ${error.message}` };
        }
      }

      // Completion stays on the parent's local event stream.
      work
        .then(result => {
          parentLoop.emitEvent({
            type: 'notice', subagentId, subagentName: name,
            message: `Subagent [${name}] finished in ${result.stepsCompleted} steps.`
          });
        })
        .catch(error => {
          parentLoop.emitEvent({
            type: 'notice', tone: 'error', subagentId, subagentName: name,
            message: `Subagent [${name}] failed: ${error.message}`
          });
        });

      return {
        success: true,
        output: JSON.stringify({
          subagentId,
          name,
          status: 'running',
          toolScope: requestedScope,
          maxSteps: record.maxSteps,
          message: `Subagent [${name}] is running. Poll it with action "list"; the result appears there when it finishes.`
        }, null, 2)
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
