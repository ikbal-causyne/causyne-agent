import { runSetup } from './tui/setup.js';
import { AgentLoop } from './agentLoop.js';
import { getProcessEntitlementGate } from './licensing/entitlements.js';
import { loadConfig, saveConfig } from './config.js';
import { ChatPrompt, isInteractive } from './tui/prompt.js';
import { switchChatWorkspace } from './tui/workspaceSwitch.js';
import { handleInput, listCommands, isCommandInput } from './commands.js';
import { CodeStreamRenderer as ChatRenderer } from './tui/codeStreamRenderer.js';
import { paint, bold, dim, GLYPHS, terminalWidth } from './tui/theme.js';
import { wordmark } from './tui/banner.js';
import { createStageSurface } from './tui/stageSurface.js';
import { wrapBlock } from './tui/text.js';
import { getPackageVersion } from './version.js';
import { resolveCharPool } from './contextManager.js';
import { PRIMARY_ACTIONS, homeStatusLine, moreLayer, configureInPrompt, mcpPicker, PROVIDERS } from './tui/home.js';
import { commandDialog } from './tui/commandPresentation.js';
import { HomeTransition } from './tui/homeTransition.js';
import { openModeControl, openVariantControl } from './tui/composerControls.js';
import { runInteractiveModelPicker } from './tui/modelPicker.js';
import { askSelect, askText, askConfirm, askDecision } from './tui/ask.js';
import { renderReport } from './reporting.js';
import { grantAlways } from './approvalGrants.js';
import { auditLog } from './auditLog.js';
import { isAcpProvider } from './providers/acp.js';
import { isPiProvider } from './providers/pi.js';
import { isAntigravityProvider } from './providers/antigravity.js';
import { runHeadlessTask, parsePermissionMode, parseMaxTurns } from './headlessCli.js';
function logoLines() {
    return wordmark(terminalWidth()).join('\n') + '\n';
}
// Local event sink. Rendering and approvals do not open network connections.
export class LocalCLIConnection {
    readyState;
    renderer;
    pendingApprovals;
    onUsageUpdate;
    constructor(renderer = null) {
        this.readyState = 1;
        this.renderer = renderer || new ChatRenderer();
        this.pendingApprovals = this.renderer.pendingApprovals;
    }
    close() {
        this.readyState = 3;
        this.stopSpinner();
    }
    get stepCount() { return this.renderer.stepCount; }
    set stepCount(value) { this.renderer.stepCount = value; }
    stopSpinner() { this.renderer.stopSpinner(); }
    send(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        }
        catch {
            return; // not a frame we produced
        }
        try {
            this.renderer.handle(msg);
            if (msg && msg.type === 'usage_update' && typeof this.onUsageUpdate === 'function') {
                this.onUsageUpdate(msg);
            }
        }
        catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`[tui] render failed for "${msg?.type}": ${errMsg}\n`);
        }
    }
}
function makeApprovalHandler(conn, dialogs = null) {
    return async (toolCallId) => {
        const detail = conn.pendingApprovals ? conn.pendingApprovals.get(toolCallId) : null;
        conn.stopSpinner();
        if (dialogs && detail) {
            const answer = await dialogs.approve(detail);
            const approved = Boolean(answer && answer.approved);
            const scope = (answer && answer.scope) || 'reject';
            if (approved && scope === 'always') {
                grantAlways(detail.tool);
                auditLog.log({ event: 'approval_granted_always', tool: detail.tool, risk: detail.risk });
            }
            if (conn.renderer && typeof conn.renderer.renderApprovalDecision === 'function') {
                conn.renderer.renderApprovalDecision(detail, approved, scope);
            }
            if (conn.pendingApprovals)
                conn.pendingApprovals.delete(toolCallId);
            return approved;
        }
        let message = 'Approve this action?';
        if (detail) {
            message = `Allow ${bold(detail.tool)} to run once?`;
        }
        else if (String(toolCallId).startsWith('circuit_breaker_')) {
            message = 'The agent has run 100 steps. Let it continue?';
        }
        else if (String(toolCallId).startsWith('tier_extension_')) {
            message = 'Step budget reached. Unlock another batch?';
        }
        if (dialogs) {
            const approved = await dialogs.confirm(message);
            if (conn.pendingApprovals)
                conn.pendingApprovals.delete(toolCallId);
            return approved;
        }
        const approved = await askConfirm(message);
        if (conn.pendingApprovals)
            conn.pendingApprovals.delete(toolCallId);
        return approved;
    };
}
/** Keep implementation choices distinct from tool permission decisions. */
function makeDecisionHandler(conn, dialogs = null) {
    return async (request) => {
        conn.stopSpinner();
        if (dialogs && typeof dialogs.decide === 'function')
            return await dialogs.decide(request);
        return await askDecision(request);
    };
}
function dimNotice(text) { return paint('muted', text); }
function openHomeMenu(prompt, conn) {
    const config = loadConfig();
    conn.renderer.write('\n' + homeStatusLine({ config }) + '\n');
    prompt.openHome(PRIMARY_ACTIONS.map((action) => ({ id: action.id, label: action.label, hint: action.hint, action })), (item) => { prompt.deliver({ homeAction: item.action }); });
}
async function runHomeAction(action, { prompt, conn, finish, loop }) {
    const reopen = () => { if (prompt)
        openHomeMenu(prompt, conn); };
    switch (action.kind) {
        case 'chat':
            return null;
        case 'stay': {
            const text = await action.run();
            conn.renderer.write('\n' + renderReport(text, { force: true }) + '\n');
            reopen();
            return null;
        }
        case 'more': {
            if (!prompt)
                return null;
            prompt.openLayer(moreLayer((picked) => {
                if (picked)
                    prompt.deliver({ homeAction: picked });
                else
                    reopen();
            }));
            return null;
        }
        case 'command': {
            const result = await handleInput(action.command, { surface: 'terminal', prompt, loop });
            if (result) {
                const wrapped = wrapBlock(result.output, conn.renderer.width()).join('\n');
                conn.renderer.write('\n' + (result.ok ? wrapped : paint('danger', wrapped)) + '\n');
            }
            if (action.id === 'model' || action.id === 'continuum' || action.id === 'sessions') {
                conn.renderer.write(homeStatusLine({ config: loadConfig() }) + '\n');
                return null;
            }
            reopen();
            return null;
        }
        case 'config': {
            if (!prompt) {
                await interactiveConfig({});
                return 'exit';
            }
            const chosen = await configureInPrompt(prompt, { loadConfig, saveConfig });
            conn.renderer.write('\n' + (chosen
                ? paint('success', `  Saved. Using ${chosen.provider} / ${chosen.model}. Connection has not been tested.`)
                : dimNotice('  Cancelled. Nothing was changed.')) + '\n');
            reopen();
            return null;
        }
        case 'mcp': {
            if (!prompt)
                return null;
            const { empty } = await mcpPicker(prompt, async (server) => {
                const verb = server.granted ? 'revoke' : 'grant';
                const result = await handleInput(`/mcp ${verb} ${server.name}`, { surface: 'terminal' });
                if (result)
                    conn.renderer.write('\n' + wrapBlock(result.output, conn.renderer.width()).join('\n') + '\n');
                reopen();
            });
            if (empty) {
                conn.renderer.write('\n' + dimNotice('  No MCP servers configured. Add one with `/mcp add <name> <command…>`.') + '\n');
                reopen();
            }
            return null;
        }
        case 'takeover':
        default: {
            if (finish)
                finish();
            await action.run();
            return 'exit';
        }
    }
}
export async function runTask(task, options = {}) {
    if (options && (options.print || options.outputFormat)) {
        await runHeadlessTask(task, options);
        return;
    }
    console.log(`\x1b[1m\x1b[36m[TASK]\x1b[0m Executing...\nTask: ${task}`);
    const conn = new LocalCLIConnection();
    const taskId = `cli_task_${Date.now()}`;
    const loopOptions = {};
    if (options?.provider)
        loopOptions.provider = options.provider;
    if (options?.model)
        loopOptions.model = options.model;
    const loop = new AgentLoop(conn, taskId, task, loopOptions);
    const permMode = parsePermissionMode(options?.permissionMode);
    if (permMode)
        loop.autonomyOverride = permMode;
    const maxTurns = parseMaxTurns(options?.maxTurns);
    if (maxTurns !== undefined)
        loop.maxStepsCeiling = maxTurns;
    loop.waitForApproval = makeApprovalHandler(conn);
    loop.waitForDecision = makeDecisionHandler(conn);
    await loop.run();
    const completed = loop._causyneTaskOutcome === 'completed';
    if (completed) {
        console.log('\n\x1b[32m[DONE]\x1b[0m Task completed and verified.\n');
    }
    else {
        console.error('\n\x1b[31m[INCOMPLETE]\x1b[0m No verified task completion was recorded.\n');
    }
    process.exitCode = completed ? 0 : 1;
}
export async function chatMode({ home = false } = {}) {
    const conn = new LocalCLIConnection();
    const taskId = `cli_chat_${Date.now()}`;
    let loop = new AgentLoop(conn, taskId, null);
    const config = loadConfig();
    const headerInfo = {
        version: `v${getPackageVersion()}`,
        provider: config.provider,
        model: config.model,
        autonomyMode: config.autonomyMode,
        tier: config.tier,
        workspace: loop.sandbox && loop.sandbox.grantAllAccess
            ? 'ALL ACCESS'
            : ((loop.sandbox && loop.sandbox.workspacePaths) || [process.cwd()]).join(', '),
        commandCount: listCommands('terminal').length,
        cwd: process.cwd(),
        contextLimit: resolveCharPool(config.tier, config.maxCharPool, {
            provider: config.provider,
            model: config.model,
            overrideTokens: config.contextTokens || config.maxContextTokens
        })
    };
    let surface = home && isInteractive() ? createStageSurface({ config }) : null;
    const openedHome = Boolean(surface);
    const bannerWidth = openedHome ? 0 : conn.renderer.sessionHeader(headerInfo);
    conn.renderer.status.setSession(headerInfo);
    if (openedHome) {
        surface.enterHome(headerInfo);
    }
    const homeTransition = new HomeTransition(openedHome, surface);
    loop.waitForApproval = makeApprovalHandler(conn);
    loop.waitForDecision = makeDecisionHandler(conn);
    let prompt = null;
    if (isInteractive()) {
        try {
            if (!surface)
                surface = createStageSurface({ config, openingWidth: bannerWidth });
            if (surface) {
                surface.setSessionInfo(headerInfo);
                conn.renderer.transcript = surface.transcript;
            }
            prompt = new ChatPrompt({
                root: process.cwd(),
                commands: listCommands('terminal'),
                isCommand: isCommandInput,
                surface,
                messageActionLoop: loop,
                onInterrupt: () => loop.abort(),
                getMode: () => loop.config?.autonomyMode || config.autonomyMode || 'B',
                onOpenMode: async () => {
                    await openModeControl(prompt, loop);
                    prompt?.refreshPinnedPanels?.(loop);
                },
                onOpenModel: async () => {
                    await runInteractiveModelPicker(prompt, { loadConfig, saveConfig }, { loop });
                    prompt?.refreshPinnedPanels?.(loop);
                },
                onOpenVariant: async () => {
                    await openVariantControl(prompt);
                    prompt?.refreshPinnedPanels?.(loop);
                },
                onExit: () => { if (prompt)
                    prompt.stop(); process.exit(0); },
                onExpand: () => conn.renderer.expandLastOutput()
            });
            conn.onUsageUpdate = () => {
                if (prompt && typeof prompt.refreshPinnedPanels === 'function')
                    prompt.refreshPinnedPanels(loop);
            };
            if (surface)
                prompt.attachSurface(surface);
            prompt.attach(conn.renderer);
            prompt.start();
            const initialHistory = loop.memoryManager ? loop.memoryManager.loadHistory() : [];
            if (!openedHome && initialHistory.length > 0) {
                conn.renderer.renderSessionHistory(initialHistory, {
                    id: loop.memoryManager?.sessionId,
                    title: loop.memoryManager?.sessionTitle,
                    messagesCount: initialHistory.length
                });
                if (surface?.viewport)
                    surface.viewport.toBottom();
            }
            if (surface)
                prompt.draw();
            loop.waitForApproval = makeApprovalHandler(conn, prompt);
            loop.waitForDecision = makeDecisionHandler(conn, prompt);
            if (conn.renderer)
                conn.renderer.dialogWillAsk = true;
            if (home && !surface)
                openHomeMenu(prompt, conn);
        }
        catch (e) {
            if (surface)
                surface.close();
            process.stderr.write(`[tui] falling back to simple input: ${e instanceof Error ? e.message : String(e)}\n`);
            prompt = null;
        }
    }
    const readTask = async () => {
        if (prompt)
            return prompt.read();
        return askText({ title: 'You' });
    };
    const finish = () => { if (prompt)
        prompt.stop(); };
    while (true) {
        let task = await readTask();
        if (task && typeof task === 'object' && task.homeAction) {
            const outcome = await runHomeAction(task.homeAction, { prompt, conn, finish, loop });
            if (outcome === 'exit')
                break;
            continue;
        }
        if (typeof task !== 'string')
            continue;
        if (['exit', 'quit'].includes(task.trim().toLowerCase())) {
            finish();
            break;
        }
        if (!task.trim())
            continue;
        const previousWorkspaceRoot = loop.workspaceRoot;
        const commandResult = await handleInput(task, { surface: 'terminal', loop, prompt });
        if (commandResult?.effect === 'workspace-changed') {
            try {
                const nextRoot = commandResult.workspaceRoot;
                loop = switchChatWorkspace({
                    workspaceRoot: nextRoot,
                    createLoop: (workspaceRoot) => new AgentLoop(conn, `cli_chat_${Date.now()}`, null, { workspaceRoot }),
                    prompt, surface, renderer: conn.renderer, headerInfo,
                    approvalHandler: makeApprovalHandler(conn, prompt),
                    decisionHandler: makeDecisionHandler(conn, prompt)
                });
                conn.renderer.write(`\n  Workspace switched to: ${nextRoot}\n`);
            }
            catch (error) {
                try {
                    process.chdir(previousWorkspaceRoot);
                }
                catch { /* report below */ }
                try {
                    prompt?.setWorkingRoot(previousWorkspaceRoot);
                }
                catch { /* report below */ }
                conn.renderer.write(`\n  Workspace switch failed: ${error instanceof Error ? error.message : String(error)}\n`);
            }
            continue;
        }
        if (commandResult) {
            if (commandResult.effect === 'clear-skill') {
                loop.activeSkill = null;
                if (surface)
                    surface.setSessionInfo({ activeSkill: null });
                if (prompt) {
                    prompt.notice = 'Active skill cleared';
                    if (typeof prompt.draw === 'function')
                        prompt.draw();
                }
                conn.renderer.write('\n' + paint('muted', '  Active skill cleared.') + '\n');
                continue;
            }
            if (commandResult.effect === 'create-skill' && prompt) {
                const { runInteractiveSkillWizard } = await import('./tui/skillAuthoring.js');
                const created = await runInteractiveSkillWizard(prompt);
                if (created) {
                    loop.activeSkill = created;
                    if (surface)
                        surface.setSessionInfo({ activeSkill: loop.activeSkill });
                    prompt.notice = `✦ Skill created & activated: ${created.domain}/${created.id}`;
                    conn.renderer.write('\n' + paint('success', `  Created and activated skill: ${bold(created.domain + '/' + created.id)}`) + '\n');
                    if (created.path)
                        conn.renderer.write(dim(`  Stored at: ${created.path}\n`));
                    if (typeof prompt.draw === 'function')
                        prompt.draw();
                }
                continue;
            }
            if (commandResult.effect === 'pick-skill' && prompt) {
                prompt.browseSkills(commandResult.items, async (skill) => {
                    if (!skill)
                        return;
                    if (skill.isCreateAction || (skill.domain === 'custom' && skill.id === 'create')) {
                        const { runInteractiveSkillWizard } = await import('./tui/skillAuthoring.js');
                        const created = await runInteractiveSkillWizard(prompt);
                        if (created) {
                            loop.activeSkill = created;
                            if (surface)
                                surface.setSessionInfo({ activeSkill: loop.activeSkill });
                            prompt.notice = `✦ Skill created & activated: ${created.domain}/${created.id}`;
                            conn.renderer.write('\n' + paint('success', `  Created and activated skill: ${bold(created.domain + '/' + created.id)}`) + '\n');
                            if (created.path)
                                conn.renderer.write(dim(`  Stored at: ${created.path}\n`));
                            if (typeof prompt.draw === 'function')
                                prompt.draw();
                        }
                        return;
                    }
                    const { readCompiledSkill } = await import('./skillsManager.js');
                    const content = readCompiledSkill(skill.domain, skill.id);
                    loop.activeSkill = {
                        id: `${skill.domain}/${skill.id}`,
                        name: skill.name || skill.id,
                        domain: skill.domain,
                        description: skill.description || '',
                        content: typeof content === 'string' ? content : ''
                    };
                    if (surface)
                        surface.setSessionInfo({ activeSkill: loop.activeSkill });
                    prompt.notice = `✦ Skill active: ${skill.domain}/${skill.id}`;
                    conn.renderer.write('\n' + paint('success', `  ✦ Activated skill: ${bold(skill.domain + '/' + skill.id)}`) + '\n');
                    if (skill.description) {
                        conn.renderer.write(dim(`  ${skill.description}\n`));
                    }
                    conn.renderer.write(dim('  Type instructions for this skill, or press Enter to apply to workspace.\n'));
                    prompt.setText('');
                    if (typeof prompt.draw === 'function')
                        prompt.draw();
                });
                continue;
            }
            if (commandResult.effect === 'silent') {
                if (prompt && typeof prompt.draw === 'function')
                    prompt.draw();
                continue;
            }
            if (commandResult.effect === 'pick-session' && prompt) {
                const { runInteractiveSessionPicker } = await import('./tui/sessionPicker.js');
                await runInteractiveSessionPicker(prompt, {
                    loop,
                    workspace: loop?.workspaceRoot || prompt?.root || process.cwd()
                });
                if (prompt && typeof prompt.draw === 'function')
                    prompt.draw();
                continue;
            }
            if (commandResult.effect === 'pick-mcp' && prompt) {
                const { empty } = await mcpPicker(prompt, (server) => {
                    const verb = server.granted ? 'revoke' : 'grant';
                    prompt.deliver(`/mcp ${verb} ${server.name}`);
                });
                if (empty)
                    prompt.showText('MCP servers', commandResult.output);
                continue;
            }
            if (commandResult.effect === 'dialog' && prompt) {
                prompt.showText(commandResult.title, commandResult.output, { danger: !commandResult.ok });
                continue;
            }
            const localDialog = prompt && commandDialog(task, commandResult);
            if (localDialog) {
                prompt.showText(localDialog.title, localDialog.text, { danger: localDialog.danger });
                continue;
            }
            if (commandResult.effect === 'invoke-skill') {
                loop.activeSkill = commandResult.skill;
                if (surface)
                    surface.setSessionInfo({ activeSkill: loop.activeSkill });
                conn.renderer.skillInvoked(commandResult.skill.id, commandResult.instruction);
                task = commandResult.instruction
                    || `Apply the ${commandResult.skill.id} skill to the current workspace.`;
            }
            else {
                const width = typeof conn.renderer.measure === 'function'
                    ? Math.max(30, conn.renderer.measure() - 4)
                    : Math.max(30, conn.renderer.width() - 4);
                const wrapped = wrapBlock(commandResult.output, width).map((line) => line ? `  ${line}` : '').join('\n');
                const body = commandResult.ok ? wrapped : paint('danger', wrapped);
                conn.renderer.write('\n' + body + '\n');
                if (commandResult.output && (commandResult.output.includes('Now using') || commandResult.output.includes('Active model switched') || commandResult.output.includes('Saved API key'))) {
                    conn.renderer.write(homeStatusLine({ config: loadConfig() }) + '\n');
                }
                if (prompt && typeof prompt.refreshPinnedPanels === 'function')
                    prompt.refreshPinnedPanels(loop);
                if (commandResult.effect === 'exit') {
                    finish();
                    break;
                }
                continue;
            }
        }
        homeTransition.beginTurn(loop);
        loop.userPrompt = task;
        loop.currentTaskPrompt = task;
        loop.taskIntentPrompt = task;
        loop.taskId = `cli_chat_${Date.now()}`;
        if (prompt && typeof prompt.consumeAttachments === 'function') {
            const atts = prompt.consumeAttachments();
            if (atts && atts.length > 0) {
                loop.attachments = atts;
            }
        }
        conn.renderer.resetTurn();
        const startedAt = Date.now();
        if (prompt)
            prompt.setBusy(true);
        try {
            const isNoKey = loop.config.provider === 'ollama' || loop.config.provider === 'acp' || isAcpProvider(loop.config.provider) || isAntigravityProvider(loop.config.provider) || isPiProvider(loop.config.provider);
            if (!loop.config.provider || (!loop.config.apiKey && !isNoKey)) {
                conn.renderer.write('\n' + paint('warn', '  No API provider or key configured.') + '\n' +
                    paint('muted', '  Run /setup or select setup from the home menu to configure your provider.\n'));
                continue;
            }
            try {
                await loop.run();
            }
            finally {
                conn.stopSpinner();
                if (surface)
                    surface.setSessionInfo({ activeSkill: loop.activeSkill });
                conn.renderer.turnFooter(Date.now() - startedAt);
            }
        }
        finally {
            if (prompt)
                prompt.setBusy(false);
        }
    }
    process.exit(0);
}
export async function execCommand(command) {
    const entitlementGate = getProcessEntitlementGate();
    try {
        await entitlementGate.begin((error) => {
            console.error('Causyne access paused:', error instanceof Error ? error.message : String(error));
        });
    }
    catch (error) {
        console.error('Causyne access unavailable:', error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
        return;
    }
    const { Sandbox } = await import('./sandbox.js');
    const sandbox = new Sandbox();
    const validation = sandbox.validate('sysRun', { command });
    if (!validation.allowed) {
        console.error(`\x1b[31m[BLOCKED]\x1b[0m ${validation.reason}`);
        process.exit(1);
    }
    if (validation.risk === 'extreme' || validation.risk === 'dangerous') {
        const approved = await askConfirm(`${paint('warn', GLYPHS.warnMark)} Run: ${command}\n  Allow once?`);
        if (!approved) {
            console.log('Cancelled.');
            process.exit(1);
        }
    }
    console.log(`Running: ${command}`);
    const { sysRun } = await import('./tools/sysRun.js');
    const result = await sysRun.execute({ command });
    if (result.success) {
        console.log(result.output);
    }
    else {
        console.error(result.error || result.output);
    }
    process.exit(result.success ? 0 : 1);
}
export async function interactiveConfig(options = {}) {
    const config = loadConfig();
    console.log(logoLines() + '\n' + bold('  Causyne Agent · Guided Setup & Configuration') + '\n'
        + dim('  Standardized UI/UX · Models · Providers · Permissions · Creative Studio Bridge\n'));
    if (options.provider || options.apikey || options.model) {
        if (options.provider && options.provider !== config.provider) {
            config.apiKey = '';
            delete config.baseUrl;
        }
        if (options.provider)
            config.provider = options.provider;
        if (options.apikey)
            config.apiKey = options.apikey;
        if (options.model)
            config.model = options.model;
        saveConfig(config);
        console.log(paint('success', '  Configuration saved via flags.') + '\n');
        return;
    }
    const result = await runSetup({ select: askSelect, text: askText }, PROVIDERS, { loadConfig, saveConfig });
    if (!result) {
        console.log('  Cancelled. Nothing was changed.\n');
        return;
    }
    let creativeSummary = '';
    try {
        const { creativeAppStatus } = await import('./creative/apps.js');
        const apps = await creativeAppStatus();
        const ready = apps.filter(a => a.available).map(a => a.label);
        creativeSummary = ready.length > 0
            ? `  ${paint('success', GLYPHS.bullet)} Creative Studio Bridge: ${ready.join(', ')} connected`
            : `  ${dim(GLYPHS.bullet + ' Creative Studio Bridge: install Blender, Premiere, Photoshop, or After Effects to activate')}`;
    }
    catch { /* ignore */ }
    console.log('\n' + paint('success', '  ✔ Saved configuration successfully!') + '\n'
        + `  Active Provider: ${bold(result.provider)}\n`
        + `  Active Model:    ${bold(result.model)}\n`
        + (creativeSummary ? `${creativeSummary}\n` : '')
        + `  Launch agent:    ${bold('causyne')} or ${bold('causyne chat')}\n`
        + `  Diagnostics:     ${bold('causyne doctor')}\n`);
    await chatMode({ home: true });
}
