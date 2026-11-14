/**
 * Rebind a chat session to a different workspace without mutating the previous
 * agent's sandbox or mixing old workspace memory into the new session.
 *
 * This module owns no disk changes or CLI command parsing. createLoop() is the
 * existing AgentLoop constructor, injected by cliMode for deterministic tests.
 */
export function switchChatWorkspace({ workspaceRoot, createLoop, prompt = null, surface = null, renderer = null, headerInfo = null, approvalHandler, decisionHandler }) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot) {
        throw new TypeError('A nonempty workspace root is required');
    }
    if (typeof createLoop !== 'function') {
        throw new TypeError('createLoop must construct a new AgentLoop');
    }
    // Build the replacement before updating any displayed state. If construction
    // fails, the previous loop and prompt remain intact for caller rollback.
    const replacement = createLoop(workspaceRoot);
    if (!replacement || replacement.workspaceRoot !== workspaceRoot) {
        throw new Error('New agent loop did not adopt the requested workspace root');
    }
    const paths = replacement.sandbox?.workspacePaths;
    if (!replacement.sandbox?.grantAllAccess &&
        (!Array.isArray(paths) || !paths.includes(workspaceRoot))) {
        throw new Error('New agent sandbox did not adopt the requested workspace root');
    }
    replacement.waitForApproval = approvalHandler;
    replacement.waitForDecision = decisionHandler;
    if (prompt) {
        if (typeof prompt.setWorkingRoot === 'function')
            prompt.setWorkingRoot(workspaceRoot);
        prompt.messageActionLoop = replacement;
        // A workspace switch is also a change of task context. Do not transfer
        // queued attachments or active skills from the previous workspace.
        prompt.pendingAttachments = [];
        prompt.completion = null;
        if (typeof prompt.scheduleDraw === 'function')
            prompt.scheduleDraw();
    }
    const workspaceLabel = replacement.sandbox?.grantAllAccess
        ? 'ALL ACCESS'
        : (Array.isArray(replacement.sandbox?.workspacePaths) ? replacement.sandbox.workspacePaths.join(', ') : '');
    if (headerInfo) {
        headerInfo.cwd = workspaceRoot;
        headerInfo.workspace = workspaceLabel;
        if (typeof renderer?.status?.setSession === 'function')
            renderer.status.setSession(headerInfo);
    }
    if (typeof surface?.setSessionInfo === 'function') {
        surface.setSessionInfo({
            ...(headerInfo || { cwd: workspaceRoot, workspace: workspaceLabel }),
            activeSkill: null
        });
    }
    return replacement;
}
