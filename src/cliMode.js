import { AgentLoop } from './agentLoop.js';
import { loadConfig, saveConfig } from './config.js';
import inquirer from './utils/inquirer.js';
import readline from 'readline';
import { ChatPrompt, isInteractive } from './tui/prompt.js';
import { handleInput, listCommands, isCommandInput } from './commands.js';
import { ChatRenderer } from './tui/chatRenderer.js';
import { paint, bold, badge, GLYPHS, terminalWidth } from './tui/theme.js';
import { wordmark } from './tui/banner.js';
import { createStageSurface } from './tui/stageSurface.js';
import { wrapBlock } from './tui/text.js';
import { getPackageVersion } from './version.js';
import { resolveCharPool } from './contextManager.js';
import { PRIMARY_ACTIONS, homeStatusLine, homeHint, moreLayer, configureInPrompt, mcpPicker, PROVIDERS } from './tui/home.js';
import { askSelect, askText, askConfirm } from './tui/ask.js';
import { renderReport } from './reporting.js';
import { grantAlways } from './approvalGrants.js';
import { auditLog } from './auditLog.js';

// One themed source for the art.
//
// This used to be a second copy of the block letters as a raw
// `\x1b[1m\x1b[36m ...` string, so the scrollback path ignored NO_COLOR — exactly
// the regression tests/tuiScreen.test.js forbids for the wordmark. Both paths now
// render the same rows through the theme.
function logoLines() {
  return wordmark(terminalWidth()).join('\n') + '\n';
}

// Local event sink. Rendering and approvals do not open network connections.
export class LocalCLIConnection {
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
    } catch (e) {
      return; // not a frame we produced
    }

    try {
      this.renderer.handle(msg);
    } catch (e) {
      // This used to be `catch(e) {}` around the whole method, so a render bug
      // silently ate the frame and the transcript just went quiet. Report it
      // once, on stderr, and keep the session alive.
      process.stderr.write(`[tui] render failed for "${msg.type}": ${e.message}\n`);
    }
  }
}

/**
 * Ask the human what the agent is about to do — and say what it is.
 *
 * L6 (local-path audit): both call sites used to prompt with a bare
 * "Action requires approval. Proceed?", which tells the user nothing and trains
 * them to press y. The detail comes from the approval_request frame the loop
 * already emits; LocalCLIConnection now keeps it.
 */
function makeApprovalHandler(conn, dialogs = null) {
  return async (toolCallId) => {
    const detail = conn.pendingApprovals ? conn.pendingApprovals.get(toolCallId) : null;
    conn.stopSpinner();

    // An interactive session asks in a panel that shows the risk, the arguments
    // and a scrollable diff in one frame. The inquirer path below asks the same
    // question in the scrollback, which is all a non-TTY session can do.
    if (dialogs && detail) {
      // Loops only for "Allow always" → Cancel: backing out of the standing
      // grant returns you to the question, it does not silently deny the call.
      // Every other path returns on the first pass.
      let approved = false;
      let scope = 'reject';

      for (;;) {
        const answer = await dialogs.approve(detail);
        approved = Boolean(answer && answer.approved);
        scope = (answer && answer.scope) || 'reject';

        if (scope !== 'always') break;

        // A SECOND, EXPLICIT CONFIRMATION — the same shape opencode uses, and
        // for the same reason: a standing grant is a much larger thing than
        // approving one call, so it must not be reachable by one keystroke.
        // The text says exactly what is being given up and for how long.
        const confirmed = await dialogs.confirm(
          `Allow ${bold(detail.tool)} to run WITHOUT asking, for the rest of this session?\n`
          + `  This lasts until Causyne restarts. Undo it any time with /approvals clear.`
        );
        if (confirmed) break;
        // Cancelled: ask again rather than denying something they never rejected.
      }

      if (approved && scope === 'always') {
        grantAlways(detail.tool);
        auditLog.log({ event: 'approval_granted_always', tool: detail.tool, risk: detail.risk });
      }

      // The transcript records the DECISION, not a second copy of the question.
      // onApprovalRequest() skips its block whenever dialogWillAsk is set, so
      // without this line the scrollback would forget the exchange entirely.
      if (conn.renderer && typeof conn.renderer.renderApprovalDecision === 'function') {
        conn.renderer.renderApprovalDecision(detail, approved, scope);
      }
      if (conn.pendingApprovals) conn.pendingApprovals.delete(toolCallId);
      return approved;
    }

    let message = 'Approve this action?';
    if (detail) {
      // No risk word here either — the question itself is the signal.
      message = `Allow ${bold(detail.tool)} to run once?`;
    } else if (String(toolCallId).startsWith('circuit_breaker_')) {
      message = 'The agent has run 100 steps. Let it continue?';
    } else if (String(toolCallId).startsWith('tier_extension_')) {
      message = 'Step budget reached. Unlock another batch?';
    }

    if (dialogs) {
      const approved = await dialogs.confirm(message);
      if (conn.pendingApprovals) conn.pendingApprovals.delete(toolCallId);
      return approved;
    }

    // No live region to draw a panel into (a piped session, or raw mode
    // refused). askConfirm degrades to readline on its own, so this path keeps
    // the same wording as the panel instead of inquirer's.
    const approved = await askConfirm(message);

    if (conn.pendingApprovals) conn.pendingApprovals.delete(toolCallId);
    return approved;
  };
}

/** Muted one-liner for menu feedback that is not success and not an error. */
function dimNotice(text) { return paint('muted', text); }

/**
 * Draw the home menu above the input line.
 *
 * The status row is committed as ordinary scrollback (UX-01: everything printed
 * is permanent history) while the menu itself lives in the live region, so it
 * erases cleanly when it is dismissed and leaves the summary behind.
 */
function openHomeMenu(prompt, conn) {
  const config = loadConfig();
  conn.renderer.write('\n' + homeStatusLine({ config }) + '\n');

  prompt.openHome(
    PRIMARY_ACTIONS.map((action) => ({ id: action.id, label: action.label, hint: action.hint, action })),
    (item) => { prompt.deliver({ homeAction: item.action }); }
  );
}

/**
 * Run one menu action.
 *
 * Nothing here reimplements a command. A 'stay' action calls the same builder
 * the subcommand calls, a 'command' action is routed through the slash registry
 * so it inherits that command's confirmation gates, and a 'takeover' hands the
 * terminal over after stopping the prompt. That is what keeps the menu from
 * becoming a second, subtly different CLI.
 */
async function runHomeAction(action, { prompt, conn, finish }) {
  const reopen = () => { if (prompt) openHomeMenu(prompt, conn); };

  switch (action.kind) {
    case 'chat':
      // Closing the menu already put the caret on the input line.
      return null;

    case 'stay': {
      const text = await action.run();
      conn.renderer.write('\n' + renderReport(text, { force: true }) + '\n');
      reopen();
      return null;
    }

    case 'more': {
      if (!prompt) return null;
      prompt.openLayer(moreLayer((picked) => {
        if (picked) prompt.deliver({ homeAction: picked });
        else reopen();
      }));
      return null;
    }

    case 'command': {
      const result = await handleInput(action.command, { surface: 'terminal', prompt });
      if (result) {
        const wrapped = wrapBlock(result.output, conn.renderer.width()).join('\n');
        conn.renderer.write('\n' + (result.ok ? wrapped : paint('danger', wrapped)) + '\n');
      }
      reopen();
      return null;
    }

    case 'config': {
      if (!prompt) { await interactiveConfig({}); return 'exit'; }
      const chosen = await configureInPrompt(prompt, { loadConfig, saveConfig });
      conn.renderer.write('\n' + (chosen
        ? paint('success', `  Saved. Using ${chosen.provider} / ${chosen.model}.`)
        : dimNotice('  Cancelled. Nothing was changed.')) + '\n');
      reopen();
      return null;
    }

    case 'mcp': {
      if (!prompt) return null;
      const { empty } = await mcpPicker(prompt, async (server) => {
        // Toggle the grant, through the same registry `/mcp` uses, so a server
        // enabled from this menu is enabled in exactly the same sense.
        const verb = server.granted ? 'revoke' : 'grant';
        const result = await handleInput(`/mcp ${verb} ${server.name}`, { surface: 'terminal' });
        if (result) conn.renderer.write('\n' + wrapBlock(result.output, conn.renderer.width()).join('\n') + '\n');
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
      // The action owns the terminal, finishes, and the session ends with it.
      // `update` is the real case: the binary changed underneath us, so carrying
      // on in a half-replaced process would be worse than exiting.
      if (finish) finish();
      await action.run();
      return 'exit';
    }
  }
}

export async function runTask(task) {
  console.log(`\x1b[1m\x1b[36m[TASK]\x1b[0m Executing...\nTask: ${task}`);
  
  const conn = new LocalCLIConnection();
  const taskId = `cli_task_${Date.now()}`;
  
  const loop = new AgentLoop(conn, taskId, task);
  
  // Local human-in-the-loop, showing WHAT is being approved (see L6).
  loop.waitForApproval = makeApprovalHandler(conn);

  await loop.run();
  console.log('\n\x1b[32m[DONE]\x1b[0m Task completed.\n');
  process.exit(0);
}


/**
 * Chat as a full-screen application.
 *
 * The scrollback renderer below is still the one producing every line — the
 * markdown, the tool rows, the diffs, the redaction all come from ChatRenderer
 * unchanged. What differs is where those lines land: a Transcript that can
 * scroll and be searched, drawn into a cell grid that repaints only the cells
 * that changed, under a modal stack that owns the keyboard while a dialog is up.
 */
export async function chatMode({ home = false } = {}) {

  // One chat surface, and it renders in the NORMAL buffer.
  //
  // There used to be a full-screen alternate-buffer shell here, chosen by
  // canRunShell(). It clears the terminal on entry (\x1b[?1049h + \x1b[2J) and
  // there is no way to detect whether a terminal honours the alternate buffer —
  // ignoring \x1b[?1049h is silent, so nothing throws and nothing falls back.
  // Where it was ignored, the clear wiped the user's screen into their scrollback
  // and the app painted a full-screen layout into their history: a blank block
  // between their shell prompt and the banner, reported twice as "there is still
  // a gap here".
  //
  // Neither reference does this. openclaw emits \x1b[?1049h nowhere at all and
  // repaints the normal buffer in place; opencode's --mini runs split-footer on
  // the main screen with clearOnShutdown false. So does this now: everything
  // printed is permanent terminal history, and only the prompt and its status
  // row are repainted. See UX-01 in .agents/rules.json.
  const conn = new LocalCLIConnection();
  const taskId = `cli_chat_${Date.now()}`;
  const loop = new AgentLoop(conn, taskId, null);

  // The context the CLI never showed: which model is about to spend the user's
  // money, in which autonomy mode, over which paths. All of it was already
  // loaded — none of it was ever displayed.
  const config = loadConfig();
  const bannerWidth = conn.renderer.sessionHeader({
    version: `v${getPackageVersion()}`,
    provider: config.provider,
    model: config.model,
    autonomyMode: config.autonomyMode,
    tier: config.tier,
    workspace: loop.sandbox && loop.sandbox.grantAllAccess
      ? 'ALL ACCESS'
      : ((loop.sandbox && loop.sandbox.workspacePaths) || [process.cwd()]).join(', '),
    commandCount: listCommands('terminal').length,
    // The idle footer's two facts. Both were already loaded and neither was ever
    // displayed once the header had scrolled away.
    cwd: process.cwd(),
    contextLimit: resolveCharPool(config.tier, config.maxCharPool)
  });
  
  loop.waitForApproval = makeApprovalHandler(conn);

  // The prompt owns the keyboard so the chat can offer history, completion and
  // typing while a turn runs. It is skipped when stdin is not a terminal (piped
  // input, CI) or when CAUSYNE_SIMPLE_INPUT=1, and any failure to take raw mode
  // falls back to the inquirer path below — a better editor must never be the
  // reason chat refuses to start.
  let prompt = null;
  if (isInteractive()) {
    try {
      // The Stage, if this terminal can hold one.
      //
      // It is opened AFTER the session header, deliberately: the wordmark stays
      // the first thing written to stdout and lands in the user's real history,
      // and the band opens below it. That keeps the UX-01 check literally true
      // and gives a seam the user can see — their shell prompt above, Causyne's
      // region below — instead of a screen that has silently become ours.
      //
      // Every null from here is a terminal that should keep the scrollback
      // renderer: not a TTY, TERM=dumb, CAUSYNE_STAGE=off, or too short to hold a
      // viewport. There is no degraded stage.
      // The banner reports the width it actually used. The opening composition
      // is laid out to it, so the input box ends where the banner's text ends
      // instead of stretching past it — and the banner itself is never narrowed,
      // because at 117 columns it already starts hiding the workspace paths.
      const surface = createStageSurface({ config, openingWidth: bannerWidth });
      if (surface) conn.renderer.transcript = surface.transcript;

      prompt = new ChatPrompt({
        root: process.cwd(),
        commands: listCommands('terminal'),
        // The rule for "is this a command" lives in commands.js and is handed
        // down rather than reimplemented, so the prompt draws a `/usage` as an
        // invocation instead of as a sentence the user supposedly said.
        isCommand: isCommandInput,
        surface,
        onInterrupt: () => loop.abort(),
        onExit: () => { if (prompt) prompt.stop(); process.exit(0); },
        onExpand: () => conn.renderer.expandLastOutput()
      });
      if (surface) prompt.attachSurface(surface);
      prompt.attach(conn.renderer);
      prompt.start();
      // The band is blank until something paints it, so the Stage needs a first
      // frame here. The scrollback path deliberately does NOT get one: there it
      // has always waited for the first keystroke, and changing that as a side
      // effect of this would be a second behaviour change riding along with the
      // one that was asked for.
      if (surface) prompt.draw();

      // Ask for approval in the prompt's own panel, not inquirer's.
      //
      // inquirer.prompt() takes stdin while this prompt is already holding it in
      // raw mode: the two contend, and the question can land on a half-drawn
      // prompt. The panel shows the risk, the arguments and a scrollable diff in
      // one frame, and dismissing it denies.
      loop.waitForApproval = makeApprovalHandler(conn, prompt);
      // From here the modal asks the question, so the renderer must stop
      // printing the full request into the transcript as well — see
      // ChatRenderer.onApprovalRequest().
      if (conn.renderer) conn.renderer.dialogWillAsk = true;
      // The key hints are part of the session header now — one hint row, not
      // three stacked lines of chrome above the first prompt.

      // Home is chat with the menu already open. Doing it here rather than in a
      // separate module is deliberate: a parallel home implementation would be a
      // second place for the live region, the completion picker and the approval
      // stack to be got wrong, and the two would drift on the first change.
      if (home) openHomeMenu(prompt, conn);
    } catch (e) {
      process.stderr.write(`[tui] falling back to simple input: ${e.message}\n`);
      prompt = null;
    }
  }

  const readTask = async () => {
    if (prompt) return prompt.read();
    const { task } = await inquirer.prompt([{
      type: 'input',
      name: 'task',
      message: '\x1b[36mYou:\x1b[0m'
    }]);
    return task;
  };

  const finish = () => { if (prompt) prompt.stop(); };

  while (true) {
    let task = await readTask();

    // A menu pick arrives through the same read() a typed line does, so there
    // is one place the loop waits and one place it dispatches.
    if (task && typeof task === 'object' && task.homeAction) {
      const outcome = await runHomeAction(task.homeAction, { prompt, conn, finish });
      if (outcome === 'exit') break;
      continue;
    }

    if (typeof task !== 'string') continue;

    if (['exit', 'quit'].includes(task.trim().toLowerCase())) {
      finish();
      break;
    }
    if (!task.trim()) continue;

    // A leading slash is a command, not a task. handleInput returns null for
    // anything else, which is what sends the line to the agent — so a prompt
    // that merely mentions a path like /usr/local is still a task.
    const commandResult = await handleInput(task, { surface: 'terminal', loop, prompt });
    if (commandResult) {
      // Route command output through the renderer, not console.log.
      //
      // console.log bypasses the prompt's onBeforeWrite/onAfterWrite hooks, so a
      // multi-line result (e.g. /skills) printed straight over the still-drawn
      // live region — the output landed on top of the status row and the prompt
      // was left doubled below it. renderer.write() lifts the live region out of
      // the way, commits the output as real scrollback, then redraws the prompt
      // beneath it. In the non-TTY fallback the hooks are undefined and this is
      // just a plain write.
      //
      // The output is also WRAPPED to the terminal width before it is written.
      // It used to go out verbatim: a `/skills` description reached 195 columns
      // on a 102-column terminal, the terminal broke it at the right edge, and
      // the fragments landed at column 0 in the middle of the next entry.
      // An interactive terminal browses 100 skills in a picker; a piped session
      
      // surfaces, and the text form remains the fallback rather than a
      // second implementation that can disagree.
      if (commandResult.effect === 'pick-skill' && prompt) {
        // Picking a skill puts it on the input line rather than running it
        // straight away, so the user can add what they want done with it. That
        // is the difference between a launcher and a document viewer.
        prompt.browseSkills(commandResult.items, (skill) => {
          prompt.setText(`/skills ${skill.domain}/${skill.id} `);
        });
        continue;
      }

      // A skill was invoked: it becomes part of the REQUEST, not terminal output.
      //
      // This is the whole point. `/skills <id>` used to print the file and call
      // continue — the body never reached a model, the trailing instruction was
      // discarded, and no API call happened at all. Now the body is attached to
      // the loop as a system message and the turn runs normally, so a skill is
      // a working method the agent follows rather than a document it shows you.
      if (commandResult.effect === 'invoke-skill') {
        loop.activeSkill = commandResult.skill;
        conn.renderer.skillInvoked(commandResult.skill.id, commandResult.instruction);
        task = commandResult.instruction
          || `Apply the ${commandResult.skill.id} skill to the current workspace.`;
        // Deliberately NOT `continue` — fall through to the agent turn below.
      } else {
        // Every other command is terminal output and nothing more.
        const width = conn.renderer.width();
        const wrapped = wrapBlock(commandResult.output, width).join('\n');
        const body = commandResult.ok ? wrapped : paint('danger', wrapped);
        conn.renderer.write('\n' + body + '\n');
        if (commandResult.effect === 'exit') { finish(); break; }
        continue;
      }
    }

    loop.userPrompt = task;
    // ONE USER REQUEST IS ONE TASK.
    //
    // The loop object is reused across the whole chat — that is deliberate, it
    // carries config and connection state — but its taskId was assigned ONCE at
    // session start and never rotated. Checkpoints group by taskId, so every
    // file every turn ever touched collapsed into a single group: `/undo` in a
    // terminal that had been open all day offered to roll back the WHOLE DAY as
    // one unit, labelled with a prompt from hours earlier. The real store shows
    // it — `cli_chat_1788970595481` holds both `hi` and `continue`.
    //
    
    // (`globalAgentLoop.taskId = message.taskId`). The terminal path simply
    // never did.
    loop.taskId = `cli_chat_${Date.now()}`;

    conn.renderer.resetTurn();
    const startedAt = Date.now();
    if (prompt) prompt.setBusy(true);
    try {
      await loop.run();
    } finally {
      // Must be released on the error path too, or one failed turn leaves the
      // prompt permanently queueing and the chat looks hung.
      if (prompt) prompt.setBusy(false);
    }
    conn.stopSpinner();
    // One turn, one skill: an invocation must not silently steer every later
    // message in the session.
    loop.activeSkill = null;
    conn.renderer.turnFooter(Date.now() - startedAt);
  }
  
  process.exit(0);
}

export async function execCommand(command) {
  // L1 (local-path audit): this used to call sysRun.execute() DIRECTLY, so
  // `causyne-agent exec` was the one path into the shell with no sandbox at all —
  // no risk classification, no approval, not even the FORBIDDEN blocklist. A
  // fork bomb or `curl … | bash` ran unchallenged, while the identical command
  // from the agent loop was blocked. Same guard, same command, same answer.
  const { Sandbox } = await import('./sandbox.js');
  const sandbox = new Sandbox();
  const validation = sandbox.validate('sysRun', { command });

  if (!validation.allowed) {
    console.error(`\x1b[31m[BLOCKED]\x1b[0m ${validation.reason}`);
    process.exit(1);
  }

  // Human-in-the-loop for anything the classifier calls risky. This is a
  // terminal, so the human is right here — ask them.
  if (validation.risk === 'extreme' || validation.risk === 'dangerous') {
    const approved = await askConfirm(
      `${paint('warn', GLYPHS.warnMark)} Run: ${command}\n  Allow once?`
    );
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
  } else {
    console.error(result.error || result.output);
  }
  process.exit(result.success ? 0 : 1);
}

export async function interactiveConfig(options) {
  const config = loadConfig();

  console.log(logoLines() + '\n' + bold('Configuration') + '\n');

  if (options.provider || options.apikey || options.model) {
    if (options.provider) config.provider = options.provider;
    if (options.apikey) config.apiKey = options.apikey;
    if (options.model) config.model = options.model;
    saveConfig(config);
    console.log(paint('success', '  Configuration saved via flags.') + '\n');
    return;
  }

  // Asked in the product's own panels rather than inquirer's.
  //
  // These were the last two surfaces on a second design system — different
  // colours, different glyphs, no NO_COLOR handling, and a list widget nothing
  // like the picker the same user sees inside `causyne`. askSelect/askText host a
  // real dialog on a temporary ChatPrompt and fall back to readline wherever raw
  // mode is unavailable. PROVIDERS is shared with the in-chat config flow, so
  // the two can no longer offer different lists.
  const provider = await askSelect({
    title: 'AI provider',
    items: PROVIDERS.map((entry) => ({ id: entry.id, label: entry.label, description: entry.hint }))
  });
  if (!provider) { console.log('  Cancelled. Nothing was changed.\n'); return; }

  const preset = PROVIDERS.find((entry) => entry.id === provider.id) || { model: '' };
  const suggested = (config.provider === provider.id && config.model) ? config.model : preset.model;

  const model = await askText({
    title: 'model',
    lines: [
      `${provider.label}`,
      '',
      'Model ids change often. Type the one you want, or accept the suggestion.'
    ],
    value: suggested,
    placeholder: 'model id'
  });
  if (model === null) { console.log('  Cancelled. Nothing was changed.\n'); return; }

  const apiKey = await askText({
    title: 'API key',
    lines: [
      `${provider.label} ${GLYPHS.arrow} ${model || suggested}`,
      '',
      'Stored encrypted in ~/.causyne/config.json. It never leaves this machine.'
    ],
    mask: true,
    placeholder: config.apiKey ? 'blank keeps the current key' : 'paste your key'
  });
  if (apiKey === null) { console.log('  Cancelled. Nothing was changed.\n'); return; }

  // Only asked where it means something. Every provider used to be shown this,
  // and for eight of the ten the right answer is always blank.
  let baseUrl = config.baseUrl || '';
  if (provider.id === 'openai-compatible' || provider.id === 'dashscope-byok' || provider.id === 'ollama') {
    const answer = await askText({
      title: 'base URL',
      lines: ['Leave blank for the provider default.', 'Required for a custom DashScope workspace endpoint.'],
      value: baseUrl,
      placeholder: 'https://…'
    });
    if (answer === null) { console.log('  Cancelled. Nothing was changed.\n'); return; }
    baseUrl = answer;
  }

  config.provider = provider.id;
  config.model = (model || suggested || '').trim();
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl && baseUrl.trim()) config.baseUrl = baseUrl.trim(); else delete config.baseUrl;

  saveConfig(config);
  console.log('\n' + paint('success', `  Saved. Using ${config.provider} / ${config.model}.`) + '\n');

  // Seamlessly transition to the home screen.
  //
  // Finishing configuration returns to the local home screen.
  await chatMode({ home: true });
}
