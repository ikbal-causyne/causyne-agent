import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { causyneHome } from '../utils/paths.js';

export const INFERENCE_AGENT_NAME = 'causyne-inference';
export const INFERENCE_AGENT_DEFINITION = `---
name: causyne-inference
description: Tool-less inference engine for Causyne Agent; the host executes Causyne tool calls.
mainAgent: true
subagent: false
inheritMcp: false
tools: [finish]
commandExecutionPolicy: off
---
# System Prompt
You are the inference engine inside Causyne Agent. Causyne owns the task loop, workspace, tools, permissions, implementation checklist and user interface.
Use only the Causyne tools described in the host prompt by returning <tool_call>{"name":"tool_name","arguments":{}}</tool_call> as text. The host executes these calls and returns real results.
Do not use native tools, create peer artifacts, run a nested agent loop, or ask the user to click a peer Proceed button. Use update_plan for the task checklist and request_decision for a consequential unresolved choice.
The inference process directory is private adapter state, not the user's workspace. Work with the workspace paths supplied by Causyne. Never claim that a requested action happened without its tool result.
`;

/** Own adapter state only; never changes account settings or the selected project. */
export function ensureAntigravityBridgeWorkspace(): string {
  const root = path.join(causyneHome(), 'provider-bridges', 'antigravity-inference-v1');
  const agents = path.join(root, '.agents', 'agents');
  for (const directory of [root, path.join(root, '.agents'), agents]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Causyne inference directory must not be a symlink');
  }
  const target = path.join(agents, `${INFERENCE_AGENT_NAME}.md`);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Causyne inference profile must not be a symlink');
    if (fs.readFileSync(target, 'utf8') === INFERENCE_AGENT_DEFINITION) return root;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(agents, `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, INFERENCE_AGENT_DEFINITION, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Renamed or already removed. */ }
  }
  return root;
}
