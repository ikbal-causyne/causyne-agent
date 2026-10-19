// Sovereign Slash-Command Registry — one table for the local terminal.
//
// WHY ONE TABLE
// Commands are declared once and rendered by the terminal chat and completion
// UI, so help, parsing and execution cannot drift apart.
//
// WHAT A COMMAND IS
// A thin, synchronous-ish surface over capability that already exists in the
// local harness. /clear is memoryManager.clearHistory(), /stop is the abort controller,
// /undo is src/checkpoints.js. Nothing here reimplements behaviour; it exposes it.
//
// ZERO-MALWARE: pure JS over existing modules. No shell, no dependency, no eval.

import { COMPILED_SKILLS } from './compiledSkills.js';
import {
  readCompiledSkill, listCompiledSkills, invalidateUserSkills, userSkillProblems
} from './skillsManager.js';
import {
  userSkillsRoot, parseSkillId, writeUserSkill, deleteUserSkill, skillTemplate
} from './userSkills.js';
import { buildContextText, buildUsageText, buildCheckpointsText, buildUndoText, buildStatusText } from './reporting.js';
import { loadConfig, saveConfig } from './config.js';
import { serverStatus, grantServer, revokeServer, addServer, removeServer } from './mcp/mcpRegistry.js';
import { analyzeFiles, formatFindings } from './slopDetector.js';
import { suggestMovements, formatMovementBrief, DESIGN_MOVEMENTS } from './designPalettes.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const SCOPES = ['local'];

function ok(output, extra = {}) {
  return { ok: true, output, ...extra };
}
function fail(output) {
  return { ok: false, output };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const COMMANDS = [
  {
    name: 'help',
    aliases: ['?', 'commands'],
    scope: 'local',
    usage: '/help [command]',
    description: 'List the available commands',
    run: (argv, ctx) => {
      const [wanted] = argv;
      if (wanted) {
        const command = resolveCommand(wanted);
        if (!command) return fail(`No command named "${wanted}". Try /help.`);
        const aliases = command.aliases?.length ? `\n  aliases : ${command.aliases.map(a => '/' + a).join(', ')}` : '';
        return ok(`${command.usage}\n  ${command.description}${aliases}`);
      }
      const visible = listCommands(ctx.surface);
      const width = Math.max(...visible.map(c => c.usage.length));
      const lines = ['Commands', ''];
      for (const command of visible) {
        lines.push(`  ${command.usage.padEnd(width)}  ${command.description}`);
      }
      lines.push('');
      lines.push('Anything not starting with / is sent to the agent as a task.');
      return ok(lines.join('\n'));
    }
  },

  {
    name: 'skill',
    scope: 'local',
    usage: '/skill new <domain>/<name> | /skill edit <domain>/<name> | /skill rm <domain>/<name> | /skill mine',
    description: 'Create, edit or remove your own skills',

    // Only the ACTIONS. This used to append the user's skill ids too, but a
    // skill id is the second argument (`/skill rm team/x`) and completion only
    // reaches the first — so accepting one produced `/skill team/x` and an
    // "Unknown action" error. Offering something in a position where it cannot
    // work is worse than offering nothing.
    complete: () => {
      const mine = listCompiledSkills().filter((skill) => skill.source === 'user');
      return [
        { value: 'new', label: 'new', description: 'scaffold a new skill you own' },
        { value: 'mine', label: 'mine', description: `list your own skills (${mine.length})` },
        { value: 'edit', label: 'edit', description: 'show where one of your skills lives' },
        { value: 'rm', label: 'rm', description: 'remove one of your skills' }
      ];
    },

    run: (argv) => {
      const [action, target, ...rest] = argv;
      const mine = () => listCompiledSkills().filter((skill) => skill.source === 'user');
      if (rest.length > 0) {
        return fail(`/skill takes at most one target. Ignored: ${JSON.stringify(rest.join(' '))}\n`
          + 'A skill name is one word: lowercase letters, digits and hyphens.');
      }

      if (!action || action === 'mine') {
        const own = mine();
        const problems = userSkillProblems();
        const lines = [`Your own skills (${own.length})`, ''];
        if (own.length === 0) {
          lines.push(`  none yet — ${userSkillsRoot()}`);
          lines.push('');
          lines.push('  /skill new <domain>/<name>   scaffold one');
          lines.push('  or ask Causyne to write one for you: "make me a skill for our release process"');
        } else {
          for (const skill of own) lines.push(`  ${skill.domain}/${skill.id} — ${skill.description}`);
          lines.push('');
          lines.push(`  stored in ${userSkillsRoot()}`);
          lines.push('  yours shadow a compiled skill of the same id, so you can correct any of them');
        }
        if (problems.length > 0) {
          lines.push('');
          lines.push('Problems:');
          for (const problem of problems) lines.push(`  ${problem}`);
        }
        return ok(lines.join('\n'));
      }

      if (action === 'new') {
        const parsed = parseSkillId(target);
        if (parsed.error) return fail(parsed.error);
        const written = writeUserSkill({
          domain: parsed.domain,
          name: parsed.name,
          content: skillTemplate(parsed.domain, parsed.name)
        });
        if (!written.ok) return fail(written.error);
        invalidateUserSkills();
        return ok([
          `Created ${parsed.domain}/${parsed.name}`,
          '',
          `  ${written.path}`,
          '',
          'Open it and fill in the workflow. Every step ends with a "Done when:" line you can',
          'actually check, and the file closes with a Verification section — that is what makes',
          'a skill a procedure rather than a note. The description decides when the agent reaches',
          'for it, so write it as "what this does. Use when …".'
        ].join('\n'));
      }

      if (action === 'edit') {
        const parsed = parseSkillId(target);
        if (parsed.error) return fail(parsed.error);
        const found = mine().find((s) => s.domain === parsed.domain && s.id === parsed.name);
        if (!found) {
          return fail(`${target} is not one of your skills. /skill mine lists them, `
            + `/skill new ${target} creates it.`);
        }
        return ok(`${target}\n\n  ${path.join(userSkillsRoot(), parsed.domain, parsed.name, 'SKILL.md')}`);
      }

      if (action === 'rm') {
        const parsed = parseSkillId(target);
        if (parsed.error) return fail(parsed.error);
        const removed = deleteUserSkill(parsed.domain, parsed.name);
        if (!removed.ok) return fail(removed.error);
        invalidateUserSkills();
        return ok(`Removed ${target}`);
      }

      return fail(`Unknown action "${action}". Use new, edit, rm or mine.`);
    }
  },
  {
    name: 'skills',
    scope: 'local',
    usage: '/skills [domain | domain/skill [instruction] | domain/skill --show]',
    description: 'Run a skill on your task, browse the library, or read one with --show',

    /**
     * Argument suggestions, offered as the user types `/skills <prefix>`.
     *
     * openclaw's contract (src/tui/commands.ts getArgumentCompletions): the
     * command owns its argument vocabulary and the prompt asks for it. Ranking
     * and filtering are the prompt's job — this returns the whole vocabulary and
     * completion.js scores it with the same function it uses for commands and
     * filenames, so `/skills doc` reaches devops/docker-multi-stage-builds by a
     * basename-prefix match rather than needing the domain typed first.
     *
     * Domains are offered alongside skills because `/skills devops` is a valid
     * argument in its own right.
     */
    complete: () => {
      const skills = listCompiledSkills();
      const domains = [...new Set(skills.map((skill) => skill.domain))]
        .map((domain) => ({
          value: domain,
          label: domain,
          description: `${skills.filter((s) => s.domain === domain).length} skills`
        }));
      return domains.concat(skills.map((skill) => ({
        value: `${skill.domain}/${skill.id}`,
        // Rank against the skill id as well as the full path, so typing the
        // skill name alone finds it without knowing which domain it lives in.
        match: `${skill.domain}/${skill.id}`,
        label: `${skill.domain}/${skill.id}`,
        description: skill.description
      })));
    },
    run: (argv) => {
      const [target] = argv;

      if (!target) {
        const catalogue = listCompiledSkills();
        if (catalogue.length === 0) return ok('No skills are compiled into this build.');

        // An interactive terminal browses; everything else reads. The picker is
        // fuzzy-searchable and truncates to its own pane, so a 100-skill library
        // stays usable and cannot overflow the terminal — the failure the flat
        // listing had at five skills, let alone a hundred.
        const summary = ['Compiled skills', ''];
        const byDomain = new Map();
        for (const skill of catalogue) {
          if (!byDomain.has(skill.domain)) byDomain.set(skill.domain, []);
          byDomain.get(skill.domain).push(skill);
        }
        for (const [domain, skills] of byDomain) {
          summary.push(`  ${domain} (${skills.length})`);
          for (const skill of skills) {
            summary.push(`    ${domain}/${skill.id} — ${skill.description || skill.name || ''}`);
          }
        }
        summary.push('');
        summary.push(`${catalogue.length} skills across ${byDomain.size} domains.`);
        summary.push('Read one with /skills <domain>/<skill>.');

        return { ok: true, output: summary.join('\n'), effect: 'pick-skill', items: catalogue };
      }

      if (target.includes('/')) {
        const separator = target.indexOf('/');
        const domain = target.slice(0, separator);
        const id = target.slice(separator + 1);
        const content = readCompiledSkill(domain, id);
        if (typeof content === 'string' && content.startsWith('Error:')) return fail(content);

        // Everything after the skill id is the TASK.
        //
        // `/skills` used to take argv[0] and discard the rest, so
        // `/skills data/notebook-to-production please produksi ini` silently
        // threw away "please produksi ini" and printed the document instead.
        const instruction = argv.slice(1).join(' ').trim();

        // `--show` reads it as a document. Anything else RUNS it.
        if (instruction === '--show' || instruction === '-s') {
          return ok(stripFrontmatter(content));
        }

        return {
          ok: true,
          effect: 'invoke-skill',
          skill: { id: `${domain}/${id}`, content },
          instruction,
          output: `${domain}/${id}`
        };
      }

      const skills = COMPILED_SKILLS[target];
      if (!skills) {
        return fail(`No skill domain "${target}". Available: ${Object.keys(COMPILED_SKILLS).join(', ')}`);
      }
      const names = Object.keys(skills);
      if (names.length === 0) return ok(`Domain "${target}" has no compiled skills.`);

      const listing = [`${target} skills (${names.length})`, '',
        ...names.map(id => `  ${target}/${id} — ${skills[id].description || ''}`)].join('\n');

      // Trailing text after a DOMAIN means the user tried to invoke something.
      // A domain is not a skill, so it cannot be run — but silently listing and
      // discarding what they typed is the same failure the skill branch had.
      const extra = argv.slice(1).join(' ').trim();
      if (extra && extra !== '--show' && extra !== '-s') {
        return fail(`"${target}" is a domain, not a skill — there is nothing to run.\n`
          + `Pick one of its skills and try again, for example:\n`
          + `  /skills ${target}/${names[0]} ${extra}\n\n${listing}`);
      }
      return ok(listing);
    }
  },

  {
    name: 'undo',
    scope: 'local',
    usage: '/undo [taskId] [--step] [--full] [--apply]',
    description: "Preview rolling back the last task's file changes (--apply to write)",
    run: (argv) => {
      const flags = new Set(argv.filter(a => a.startsWith('--')));
      const taskId = argv.find(a => !a.startsWith('--'));

      // PREVIEW by default. Typing /undo used to restore files immediately —
      // no preview, no confirmation, and none of the running-task guard the
      // structured rollback flow has. A chat box is not a place where one word
      // should be able to overwrite a day's work, so the destructive form has
      // to be asked for by name.
      const apply = flags.has('--apply');

      const { ok: succeeded, text } = buildUndoText(taskId, {
        step: flags.has('--step'),
        full: flags.has('--full'),
        dryRun: !apply
      });

      if (!succeeded) return fail(text);
      if (apply) return ok(text);
      return ok(`${text}\n\nNothing was written. Run the same command with --apply to restore these files.`);
    }
  },

  {
    name: 'print',
    scope: 'local',
    usage: '/print',
    description: 'Flush this session into the terminal scrollback and start the stage clean',
    run: (argv, ctx) => {
      // The Stage keeps the transcript in memory and paints a window of it, so
      // until you exit, nothing is in your terminal's own scrollback to grep,
      // copy or pipe. This is the way out without ending the session — and it
      // prints BEFORE clearing, because ctrl+L in a terminal leaves your history
      // behind and so must this.
      const surface = ctx && ctx.prompt && ctx.prompt.surface;
      if (!surface) {
        return ok('Nothing to flush: this session already prints straight into your terminal.');
      }
      const rows = surface.flushAndClear();
      return ok(`Printed ${rows} row${rows === 1 ? '' : 's'} into your terminal scrollback.`);
    }
  },

  {
    name: 'checkpoints',
    aliases: ['ck'],
    scope: 'local',
    usage: '/checkpoints [count]',
    description: 'List recent undo checkpoints',
    run: (argv) => ok(buildCheckpointsText(parseInt(argv[0], 10) || 15))
  },

  {
    name: 'context',
    aliases: ['ctx'],
    scope: 'local',
    usage: '/context',
    description: 'Show what fills the context window',
    run: () => ok(buildContextText())
  },

  {
    name: 'usage',
    aliases: ['cost'],
    scope: 'local',
    usage: '/usage',
    description: 'Show token usage and estimated cost',
    run: async () => ok(await buildUsageText())
  },

  {
    name: 'cortex',
    aliases: ['brain'],
    scope: 'local',
    usage: '/cortex [list | forget <id> | forget-here]',
    description: 'Inspect what the agent has learned, and forget any of it',
    // A memory store you cannot read is not a memory, it is a black box that
    // occasionally changes the agent's behaviour. Section 4 asks for intelligent
    // safety rather than opacity, and section 10 layer 5 asks for a trail a
    // human can review. This is that surface.
    run: async (args = []) => {
      const { cortexDb } = await import('./cortex/vectorDb.js');
      const verb = String(args[0] || '').toLowerCase();

      try {
        if (verb === 'forget' && args[1]) {
          const removed = await cortexDb.forget({ id: args[1] });
          return removed ? ok('Forgotten.') : fail(`No memory "${args[1]}".`);
        }

        if (verb === 'forget-here') {
          const removed = await cortexDb.forget({ workspace: process.cwd() });
          return ok(removed === 0
            ? 'Nothing was learned in this project yet.'
            : `Forgot ${removed} memor${removed === 1 ? 'y' : 'ies'} from this project. Global lessons are untouched.`);
        }

        const stats = await cortexDb.stats();
        if (stats.total === 0) {
          return ok('Nothing learned yet. Cortex records a lesson when a task recovers from a real error.');
        }

        const kinds = stats.byKind.map((k) => `${k.c} ${k.kind}`).join(', ');
        const age = stats.newest ? new Date(stats.newest).toISOString().slice(0, 10) : 'never';
        const header = `${stats.total} memories (${kinds}) across ${stats.workspaces} project(s). Newest: ${age}.`;

        if (verb !== 'list') {
          return ok(header + '\n\nSee them with /cortex list. Forget this project\'s with /cortex forget-here.');
        }

        const rows = await cortexDb.inventory({ workspace: process.cwd() });
        if (rows.length === 0) {
          return ok(header + '\n\nNothing applies to this project.');
        }

        const home = process.env.HOME || '';
        const lines = rows.slice(0, 15).map((r) => {
          const when = new Date(r.timestamp).toISOString().slice(0, 10);
          const where = r.workspace ? (home ? r.workspace.replace(home, '~') : r.workspace) : 'global';
          const first = String(r.text).split('\n').filter(Boolean).slice(0, 2).join(' — ').slice(0, 96);
          return `  ${r.id}  ${when}  ${String(r.hits).padStart(3)} hits  [${r.kind}] ${where}\n      ${first}`;
        });

        return ok(header + '\n\nApplying to this project:\n' + lines.join('\n')
          + '\n\nForget one with /cortex forget <id>.');
      } catch (e) {
        // The neural engine is provisioned at runtime and can be absent. Saying
        // so is the point: a silent Cortex is indistinguishable from an empty
        // one, and the user is entitled to know which they have.
        return fail(`Cortex is unavailable: ${e.message}. Memories are not being recorded or retrieved.`);
      }
    }
  },

  {
    name: 'sessions',
    aliases: ['session'],
    scope: 'local',
    usage: '/sessions [switch <id> | delete <id>]',
    description: 'List chat sessions, or switch to one',
    // Sessions replaced ONE global chat_history.json that every directory read.
    // A session you cannot list or switch to is not a session, so this ships
    // with the store rather than after it.
    run: async (args = [], context = {}) => {
      const store = await import('./sessionStore.js');
      const verb = String(args[0] || '').toLowerCase();
      const memory = context.loop && context.loop.memoryManager;

      if (verb === 'switch' && args[1]) {
        const next = memory ? memory.useSession(args[1]) : store.switchSession(args[1]);
        if (!next) return fail(`No session "${args[1]}".`);
        if (context.loop) context.loop.messages = next.messages.filter(m => m.role !== 'system');
        return ok(`Switched to "${next.title}" (${next.messages.length} messages).`);
      }

      if (verb === 'delete' && args[1]) {
        return store.deleteSession(args[1]) ? ok('Session deleted.') : fail(`No session "${args[1]}".`);
      }

      const rows = store.listSessions();
      if (rows.length === 0) {
        return ok('No sessions yet. This conversation becomes one as soon as you send something.');
      }

      const active = store.getActiveSessionId();
      const home = process.env.HOME || '';
      const lines = rows.slice(0, 20).map((s) => {
        const when = new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        const where = s.workspace ? (home ? s.workspace.replace(home, '~') : s.workspace) : '(no workspace)';
        const mark = s.id === active ? '*' : ' ';
        return `  ${mark} ${s.id}  ${when}  ${String(s.messageCount).padStart(4)} msg  ${where}\n      ${s.title}`;
      });

      return ok(
        `${rows.length} session${rows.length === 1 ? '' : 's'} (* = active):\n`
        + lines.join('\n')
        + '\n\nSwitch with /sessions switch <id>. A new directory always starts a new session.'
      );
    }
  },

  {
    name: 'approvals',
    scope: 'local',
    usage: '/approvals [clear]',
    description: 'List tools granted "Allow always", or revoke them',
    // A standing grant with no way to see or revoke it is a trap, not a
    // convenience. This is the way out, and the confirm dialog that grants one
    // names this command so the user is told about it at the moment it matters.
    run: async (args = []) => {
      const { listAlwaysAllowed, revokeAllAlways } = await import('./approvalGrants.js');

      if (String(args[0] || '').toLowerCase() === 'clear') {
        const count = revokeAllAlways();
        return ok(count === 0
          ? 'No standing approvals to revoke.'
          : `Revoked ${count} standing approval${count === 1 ? '' : 's'}. Causyne will ask again.`);
      }

      const granted = listAlwaysAllowed();
      if (granted.length === 0) {
        return ok('No standing approvals. Every gated action still asks.');
      }
      return ok(
        'Running without asking, until Causyne restarts:\n'
        + granted.map((tool) => `  - ${tool}`).join('\n')
        + '\n\nRevoke with /approvals clear.'
      );
    }
  },

  {
    name: 'clear',
    aliases: ['reset', 'new'],
    scope: 'local',
    usage: '/clear',
    description: 'Clear the conversation and start from a fresh context',
    run: (argv, ctx) => {
      const loop = ctx.loop;
      if (loop) {
        loop.messages = [];
        loop.unlockedPacks = new Set();
        loop.unlockedTools = new Set();
        loop.unlockOrder = [];
        loop.staticContext = null;
        loop.isInitialized = false;
        if (typeof loop.rearmAbortController === 'function') loop.rearmAbortController();
        if (loop.memoryManager) loop.memoryManager.clearHistory();
        return ok('Conversation cleared. The next task starts from a clean context.');
      }
      return fail('No active session to clear.');
    }
  },

  {
    name: 'stop',
    aliases: ['abort'],
    scope: 'local',
    usage: '/stop',
    description: 'Stop the task that is currently running',
    run: (argv, ctx) => {
      const loop = ctx.loop;
      if (loop && typeof loop.abort === 'function') {
        loop.abort();
        return ok('Stop requested.');
      }
      return fail('Nothing is running.');
    }
  },

  {
    name: 'model',
    scope: 'local',
    usage: '/model [provider/model | model]',
    description: 'Show or change the model in use',
    run: (argv) => {
      const config = loadConfig();
      if (argv.length === 0) {
        return ok(`Provider : ${config.provider || 'default'}\nModel    : ${config.model || 'default'}`);
      }
      const requested = argv.join(' ').trim();
      const separator = requested.indexOf('/');
      // A bare name changes only the model; "provider/model" changes both. Any
      // string is accepted — model ids move faster than any hardcoded list, and
      // guessing from memory is exactly what .agents/AGENTS.md §3 forbids.
      if (separator > 0) {
        config.provider = requested.slice(0, separator);
        config.model = requested.slice(separator + 1);
      } else {
        config.model = requested;
      }
      saveConfig(config);
      return ok(`Now using ${config.provider} / ${config.model}.`);
    }
  },

  {
    name: 'mcp',
    scope: 'local',
    usage: '/mcp [add <name> <cmd…> | add <name> --url <url> | remove|grant|revoke <name>]',
    description: 'Manage MCP servers: list, add, remove, grant, revoke',
    run: (argv) => {
      const [action, serverName, ...rest] = argv;

      if (action === 'add') {
        if (!serverName) {
          return fail('Usage: mcp add <name> <command> [args…]\n   or: mcp add <name> --url <https://…>');
        }
        if (rest.length === 0) return fail(`Give "${serverName}" a command to run, or --url for an HTTP server.`);

        let definition;
        if (rest[0] === '--url') {
          if (!rest[1]) return fail('--url needs a URL.');
          definition = { name: serverName, url: rest[1] };
        } else {
          definition = { name: serverName, command: rest[0], args: rest.slice(1) };
        }

        const result = addServer(definition);
        if (!result.ok) return fail(`Could not add "${serverName}": ${result.error}`);

        // Registering is not consenting — say so, because a stdio server is a
        // process Causyne will spawn on this machine.
        return ok(
          `Added "${serverName}".\n\n`
          + `It is NOT enabled yet. A stdio MCP server is a program Causyne runs on\n`
          + `this computer, so enabling it is a separate, deliberate step:\n`
          + `  mcp grant ${serverName}`
        );
      }

      if (action === 'remove') {
        if (!serverName) return fail('Usage: /mcp remove <server>');
        const result = removeServer(serverName);
        if (!result.ok) return fail(result.error);
        return ok(`Removed "${serverName}" and dropped its consent.`);
      }

      if (action === 'grant' || action === 'revoke') {
        if (!serverName) return fail(`Usage: /mcp ${action} <server>`);
        const known = serverStatus().some(s => s.name === serverName);
        if (!known) return fail(`No MCP server named "${serverName}" is configured.`);
        if (action === 'grant') {
          grantServer(serverName);
          return ok(`Granted "${serverName}". Its tools enter the catalogue on the next task.`);
        }
        revokeServer(serverName);
        return ok(`Revoked "${serverName}". Its tools are no longer callable.`);
      }

      if (action) {
        return fail(`Unknown mcp action "${action}". Try: add, remove, grant, revoke, or mcp on its own to list.`);
      }

      const servers = serverStatus();
      if (servers.length === 0) {
        return ok('No MCP servers are configured.\n\nAdd one with:\n  mcp add <name> <command> [args…]\n  mcp add <name> --url <https://…>\n\n(prefix with / in chat, or `causyne-agent mcp …` in a terminal)');
      }
      const lines = ['MCP servers', ''];
      for (const server of servers) {
        lines.push(`  ${server.name}  [${server.transport}]  ${server.granted ? 'granted' : 'NOT granted'}${server.connected ? ', connected' : ''}`);
        lines.push(`    ${server.target}`);
        if (server.tools.length > 0) lines.push(`    tools: ${server.tools.join(', ')}`);
      }
      lines.push('');
      lines.push('  mcp grant <name> to enable, mcp remove <name> to delete.');
      return ok(lines.join('\n'));
    }
  },

  {
    name: 'slop',
    scope: 'local',
    usage: '/slop <file… | directory> [--movements]',
    description: 'Score HTML/CSS against the anti-AI-slop rules (Vision §7)',
    run: (argv) => {
      const wantsMovements = argv.includes('--movements');
      const targets = argv.filter(a => !a.startsWith('--'));

      if (wantsMovements && targets.length === 0) {
        return ok('Design movements to commit to:\n\n' + formatMovementBrief(DESIGN_MOVEMENTS));
      }
      if (targets.length === 0) {
        return fail('Usage: slop <file… | directory>   (or: slop --movements to see the catalogue)');
      }

      const files = [];
      const collect = (target) => {
        const resolved = path.resolve(String(target).replace(/^~\//, os.homedir() + '/'));
        let stats;
        try { stats = fs.statSync(resolved); } catch (e) { return `not found: ${target}`; }

        if (stats.isDirectory()) {
          const stack = [resolved];
          while (stack.length > 0 && files.length < 200) {
            const dir = stack.pop();
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
            for (const entry of entries) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) stack.push(full);
              else if (entry.isFile()) {
                try { files.push({ path: full, content: fs.readFileSync(full, 'utf8') }); } catch (e) {}
              }
            }
          }
          return null;
        }
        try { files.push({ path: resolved, content: fs.readFileSync(resolved, 'utf8') }); } catch (e) {
          return `could not read: ${target}`;
        }
        return null;
      };

      const problems = targets.map(collect).filter(Boolean);
      if (files.length === 0) {
        return fail(problems.length > 0 ? problems.join('\n') : 'Nothing to scan.');
      }

      const result = analyzeFiles(files);
      if (result.scanned.length === 0) {
        return ok('No HTML/CSS/component files among the targets — nothing to score.');
      }
      if (result.findings.length === 0) {
        return ok(`Scanned ${result.scanned.length} file(s). Score 0 — clean. No slop signatures found.`);
      }
      const brief = result.verdict === 'slop' ? formatMovementBrief(suggestMovements([], 3)) : '';
      return ok(`Scanned ${result.scanned.length} file(s).\n\n` + formatFindings(result, brief));
    }
  },

  {
    name: 'status',
    scope: 'local',
    usage: '/status',
    description: 'Show the current provider, autonomy mode and workspace scope',
    // One builder, shared with `causyne status`, so status output cannot drift.
    run: (argv, ctx) => ok(buildStatusText({ loop: ctx.loop || null }))
  },

  {
    name: 'exit',
    aliases: ['quit'],
    scope: 'local',
    usage: '/exit',
    description: 'Leave the chat',
    run: () => ok('Goodbye.', { effect: 'exit' })
  }
];

// ---------------------------------------------------------------------------
// Lookup and parsing
// ---------------------------------------------------------------------------

export function resolveCommand(name) {
  const normalized = String(name || '').replace(/^\//, '').trim().toLowerCase();
  if (!normalized) return null;
  return COMMANDS.find(c => c.name === normalized || (c.aliases || []).includes(normalized)) || null;
}

/** Commands visible on the local terminal surface. */
/**
 * Drop the YAML frontmatter before showing a skill to a human.
 *
 * The frontmatter is routing metadata for the agent — `name:` and
 * `description:` — and printing it verbatim is why an invoked skill looked like
 * a file dump rather than a procedure.
 */
function stripFrontmatter(content) {
  return String(content == null ? '' : content).replace(/^---\n[\s\S]*?\n---\n*/, '');
}

export function listCommands(surface = 'terminal') {
  return surface === 'terminal' ? COMMANDS.slice() : [];
}

/**
 * Split a raw input line into a command and its arguments.
 *
 * Returns null for anything that is not a slash command, which is the signal to
 * the caller that this line is a task for the agent. A bare "/" is not a
 * command, and neither is a path like "/usr/local/bin" — requiring a letter
 * immediately after the slash keeps absolute paths out of the command namespace.
 */
export function parseCommand(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = (parts.shift() || '').toLowerCase();

  // The name must be a single bare word. Requiring that is what keeps absolute
  // paths out of the command namespace: "/usr/local/bin" has a slash in its
  // first token, so it is a task for the agent, not a command named
  // "usr/local/bin". Anchored, not a loose prefix test — see rules.json ZM-09
  // on why guards must be context-aware.
  if (!/^[a-z?][a-z0-9_-]*$/.test(name)) return null;

  return { name, argv: parts, raw: trimmed };
}

export function isCommandInput(input) {
  return parseCommand(input) !== null;
}

/**
 * Execute a parsed command.
 *
 * Never throws: a command that fails reports it as output, because both surfaces
 * render the result into a conversation rather than a stack trace.
 */
export async function runCommand(name, argv = [], ctx = {}) {
  const surface = ctx.surface || 'terminal';
  const command = resolveCommand(name);

  if (!command) {
    return fail(`Unknown command "/${name}". Try /help.`);
  }
  if (surface !== 'terminal') {
    return fail(`"/${command.name}" is not available on this surface.`);
  }

  try {
    return await command.run(argv, { ...ctx, surface });
  } catch (e) {
    return fail(`/${command.name} failed: ${e.message}`);
  }
}

/** Convenience for a surface holding a raw line. Returns null if not a command. */
export async function handleInput(input, ctx = {}) {
  const parsed = parseCommand(input);
  if (!parsed) return null;
  return runCommand(parsed.name, parsed.argv, ctx);
}
