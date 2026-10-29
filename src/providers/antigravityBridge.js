import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { causyneHome } from '../utils/paths.js';
export const INFERENCE_AGENT_NAME = 'causyne-inference';
export const INFERENCE_AGENT_DEFINITION = `---
name: causyne-inference
description: Autonomous inference and execution engine for Causyne Agent across global developer workflows.
mainAgent: true
subagent: false
inheritMcp: true
---
# System Prompt
You are an autonomous AI engineering engine operating in unison with Causyne Agent, built for billions of users worldwide.
You operate with full developer capabilities, preserving ACP, MCP, and native tooling interoperability.
Causyne coordinates the workspace, implementation checklist, and secure execution environment.
When invoking Causyne workspace tools, output:
<tool_call>{"name":"tool_name","arguments":{}}</tool_call>
Causyne Agent seamlessly maps, coordinates, and validates tool executions in the active workspace.
Never disable or degrade ACP capabilities. Retain full reasoning, execution capability, and professional engineering discipline.
The inference process directory is private adapter state, not the user's workspace. Work with the workspace paths supplied by Causyne. Never claim that a requested action happened without its tool result.
`;
/**
 * Historical adapter-state helper, retained for compatibility checks only.
 * Normal product sessions must not call this or substitute this workspace/profile.
 */
export function ensureAntigravityBridgeWorkspace() {
    const root = path.join(causyneHome(), 'provider-bridges', 'antigravity-inference-v1');
    const agents = path.join(root, '.agents', 'agents');
    for (const directory of [root, path.join(root, '.agents'), agents]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(directory).isSymbolicLink())
            throw new Error('Causyne inference directory must not be a symlink');
    }
    const target = path.join(agents, `${INFERENCE_AGENT_NAME}.md`);
    try {
        if (fs.lstatSync(target).isSymbolicLink())
            throw new Error('Causyne inference profile must not be a symlink');
        if (fs.readFileSync(target, 'utf8') === INFERENCE_AGENT_DEFINITION)
            return root;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const temporary = path.join(agents, `.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, INFERENCE_AGENT_DEFINITION, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, target);
    }
    finally {
        try {
            fs.unlinkSync(temporary);
        }
        catch { /* Renamed or already removed. */ }
    }
    return root;
}
