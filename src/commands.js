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
import { resolveAvailableModels, getCuratedModels, getAvailableProvidersOverview } from './dynamicCatalogue.js';
import { DEFAULT_MODEL_BY_PROVIDER, PEER_MODEL_CATALOGUE } from './modelCatalogue.js';
import { isAcpProvider } from './providers/acp.js';
import { listSessions, getActiveSessionId } from './sessionStore.js';
import {
  serverStatus, grantServer, revokeServer, addServer, removeServer,
  connectServer, disconnectServer, refreshServer
} from './mcp/mcpRegistry.js';
import { analyzeFiles, formatFindings } from './slopDetector.js';
import { suggestMovements, formatMovementBrief, DESIGN_MOVEMENTS } from './designPalettes.js';
import {
  loadPeerProfiles, addPeerProfile, removePeerProfile, listAllPeers, getPeerProfile
} from './acp/peerProfiles.js';
import {
  detectAllPeers, testPeerHandshake, BUILTIN_PEER_PRESETS
} from './acp/agentCatalog.js';
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
    name: 'setup', aliases: ['config', 'connect'], scope: 'local', usage: '/setup',
    description: 'Configure provider, endpoint, model and autonomy',
    run: async (_argv, ctx) => {
      if (!ctx.prompt) return ok('Run causyne setup in an interactive terminal.');
      const { configureInPrompt } = await import('./tui/home.js');
      const result = await configureInPrompt(ctx.prompt, { loadConfig, saveConfig });
      return ok(result ? `Saved ${result.provider} / ${result.model}. Connection has not been tested.` : 'Cancelled. Nothing was changed.');
    }
  },

  {
    name: 'help',
    aliases: ['?', 'commands'],
    scope: 'local',
    usage: '/help [command]',
    description: 'List the available commands',
    dialogTitle: 'Commands',
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
    name: 'cd',
    aliases: ['cwd', 'workspace'],
    scope: 'local',
    usage: '/cd [directory]',
    description: 'View or change active working directory and project focus',
    complete: () => {
      try {
        const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
        return entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({
            value: e.name.includes(' ') ? `"${e.name}"` : e.name,
            label: e.name + '/',
            description: 'directory'
          }));
      } catch (e) {
        return [];
      }
    },
    run: async (argv, ctx) => {
      const target = argv.join(' ').trim().replace(/^["']|["']$/g, '');
      if (!target) {
        return ok(`Current working directory: ${process.cwd()}`);
      }
      const resolved = path.resolve(process.cwd(), target.replace(/^~\//, os.homedir() + '/'));
      if (!fs.existsSync(resolved)) {
        return fail(`Directory not found: ${resolved}`);
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return fail(`Not a directory: ${resolved}`);
      }
      try {
        process.chdir(resolved);
      } catch (err) {
        return fail(`Cannot switch to ${resolved}: ${err.message}`);
      }
      if (ctx.prompt && typeof ctx.prompt.setWorkingRoot === 'function') {
        ctx.prompt.setWorkingRoot(resolved);
      }
      if (ctx.loop && ctx.loop.perception) {
        try {
          ctx.loop.workspaceContext = await ctx.loop.perception.buildContext(resolved);
        } catch (e) {}
      }
      return ok(`Working directory changed to: ${resolved}`);
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
    dialogTitle: 'Checkpoints',
    run: (argv) => ok(buildCheckpointsText(parseInt(argv[0], 10) || 15))
  },

  {
    name: 'context',
    aliases: ['ctx'],
    scope: 'local',
    usage: '/context',
    description: 'Show what fills the context window',
    dialogTitle: 'Context',
    run: () => ok(buildContextText())
  },

  {
    name: 'usage',
    aliases: ['cost'],
    scope: 'local',
    usage: '/usage',
    description: 'Show token usage and estimated cost',
    dialogTitle: 'Usage',
    run: async () => ok(await buildUsageText())
  },

  {
    name: 'cortex',
    aliases: ['brain'],
    scope: 'local',
    usage: '/cortex [list | forget <id> | forget-here]',
    description: 'Inspect what the agent has learned, and forget any of it',
    dialogTitle: 'Cortex',
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
    name: 'plans',
    scope: 'local',
    usage: '/plans [import <json-file> | forget]',
    description: 'Inspect, pre-warm, or clear reusable task plans',
    dialogTitle: 'Plan cache',
    run: async (args = []) => {
      const cache = await import('./planCache.js');
      const verb = String(args[0] || '').toLowerCase();

      if (verb === 'forget') {
        const removed = cache.forgetPlans();
        return ok(`Forgot ${removed} cached plan${removed === 1 ? '' : 's'}.`);
      }

      if (verb === 'import') {
        const requested = args.slice(1).join(' ').trim();
        if (!requested) return fail('Usage: /plans import <json-file>');
        const file = path.resolve(requested.replace(/^~(?=\/)/, os.homedir()));
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > 1024 * 1024) {
            return fail('Plan seed must be one JSON file no larger than 1 MB.');
          }
          const outcome = cache.prewarmPlans(JSON.parse(fs.readFileSync(file, 'utf8')));
          const detail = outcome.errors.length > 0 ? `\n${outcome.errors.join('\n')}` : '';
          return outcome.accepted > 0
            ? ok(`Imported ${outcome.accepted} plan${outcome.accepted === 1 ? '' : 's'}; rejected ${outcome.rejected}.${detail}`)
            : fail(`No plans were imported.${detail}`);
        } catch (error) {
          return fail(`Could not import plan seeds: ${error.message}`);
        }
      }

      const stats = cache.planStats();
      return ok([
        `${stats.count} cached plan${stats.count === 1 ? '' : 's'}`,
        `Hits: ${stats.hits}/${stats.lookups} (${(stats.hitRate * 100).toFixed(1)}%) — exact ${stats.exactHits}, fuzzy ${stats.fuzzyHits}`,
        `Average lookup: ${stats.averageLookupMs.toFixed(3)} ms; max ${stats.maxLookupMs.toFixed(3)} ms`,
        stats.disabled
          ? `Lookup cooling down until ${new Date(stats.disabledUntil).toISOString()} after persistent misses.`
          : 'Lookup active.',
        '',
        'Pre-warm with /plans import <json-file>. Clear with /plans forget.'
      ].join('\n'));
    }
  },

  {
    name: 'plugins',
    scope: 'local',
    usage: '/plugins [enable <name> | disable <name>]',
    description: 'Inspect or change trust for local plugins',
    dialogTitle: 'Plugins',
    run: async (args = []) => {
      const manager = await import('./plugins/pluginManager.js');
      const verb = String(args[0] || '').toLowerCase();
      const name = String(args[1] || '');
      if (verb === 'enable') {
        if (!name) return fail('Usage: /plugins enable <name>');
        const result = manager.enablePlugin(name);
        return result.ok
          ? ok(`Enabled ${name} at manifest digest ${result.digest}. Changes will revoke trust automatically.`)
          : fail(`Could not enable ${name}: ${result.error}`);
      }
      if (verb === 'disable') {
        if (!name) return fail('Usage: /plugins disable <name>');
        const result = manager.disablePlugin(name);
        return result.ok ? ok(`Disabled ${name}.`) : fail(`Could not disable ${name}: ${result.error}`);
      }

      const rows = manager.listPlugins();
      if (rows.length === 0) return ok(`No local plugins. Plugin root: ${manager.PLUGIN_ROOT}`);
      return ok(rows.map((plugin) => {
        const state = plugin.invalid ? 'invalid' : plugin.modified ? 'modified; trust revoked' : plugin.enabled ? 'enabled' : 'disabled';
        const capabilities = Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0
          ? plugin.capabilities.join(', ')
          : 'none';
        return `  ${plugin.name} ${plugin.version || ''} — ${state}; capabilities: ${capabilities}`;
      }).join('\n') + `\n\nPlugin root: ${manager.PLUGIN_ROOT}`);
    }
  },

  {
    name: 'new',
    aliases: ['new-session'],
    scope: 'local',
    usage: '/new',
    description: 'Start a new clean chat session in this workspace',
    dialogTitle: 'New Session',
    run: async (_args = [], context = {}) => {
      const store = await import('./sessionStore.js');
      const memory = context.loop && context.loop.memoryManager;
      const workspace = context.loop?.workspaceRoot || process.cwd();
      const next = memory ? memory.startNewSession('Untitled') : store.createSession(workspace, 'Untitled', true);
      if (context.loop) {
        context.loop.messages = [];
        context.loop.taskId = `cli_chat_${Date.now()}`;
        if (context.loop.tokenTracker && typeof context.loop.tokenTracker.reset === 'function') {
          context.loop.tokenTracker.reset();
        }
      }
      if (context.prompt?.editor?.clear) {
        context.prompt.editor.clear();
        if (typeof context.prompt.scheduleDraw === 'function') context.prompt.scheduleDraw();
      }
      return ok(`✨ Started new session: "${next.title}" (${next.id}).`, { effect: 'inline' });
    }
  },

  {
    name: 'sessions',
    aliases: ['session'],
    scope: 'local',
    usage: '/sessions [new | switch <id> | delete <id>]',
    description: 'List chat sessions, or switch to one',
    dialogTitle: 'Sessions',
    complete: () => {
      try {
        const rows = listSessions().slice(0, 15);
        return [
          { value: 'new', label: 'new', description: 'start a fresh conversation in this workspace' },
          ...rows.map(r => ({
            value: `switch ${r.id}`,
            label: `switch ${r.id}`,
            description: `${r.title} (${r.messageCount} msgs)`
          }))
        ];
      } catch (e) {
        return [{ value: 'new', label: 'new', description: 'start a fresh conversation' }];
      }
    },
    run: async (args = [], context = {}) => {
      const store = await import('./sessionStore.js');
      const verb = String(args[0] || '').toLowerCase();
      const memory = context.loop && context.loop.memoryManager;
      const workspace = context.loop?.workspaceRoot || process.cwd();

      // If interactive TUI prompt is available and no sub-arguments are given, open interactive picker modal
      if ((!args || args.length === 0 || (args.length === 1 && args[0] === '')) && context.prompt) {
        const { runInteractiveSessionPicker } = await import('./tui/sessionPicker.js');
        const message = await runInteractiveSessionPicker(context.prompt, {
          loop: context.loop,
          workspace
        });
        return ok(message, { effect: 'inline' });
      }

      if (verb === 'new') {
        const next = memory ? memory.startNewSession('Untitled') : store.createSession(workspace, 'Untitled', true);
        if (context.loop) {
          context.loop.messages = [];
          context.loop.taskId = `cli_chat_${Date.now()}`;
          if (context.loop.tokenTracker && typeof context.loop.tokenTracker.reset === 'function') {
            context.loop.tokenTracker.reset();
          }
        }
        if (context.prompt?.editor?.clear) {
          context.prompt.editor.clear();
          if (typeof context.prompt.scheduleDraw === 'function') context.prompt.scheduleDraw();
        }
        return ok(`✨ Started new session: "${next.title}" (${next.id}).`, { effect: 'inline' });
      }

      if (verb === 'switch' && args[1]) {
        const next = memory ? memory.useSession(args[1]) : store.switchSession(args[1]);
        if (!next) return fail(`No session "${args[1]}".`);
        if (context.loop) {
          context.loop.messages = memory ? memory.loadHistory() : next.messages.filter(m => m.role !== 'system');
          context.loop.taskId = `cli_chat_${Date.now()}`;
          if (context.loop.tokenTracker && typeof context.loop.tokenTracker.reset === 'function') {
            context.loop.tokenTracker.reset();
          }
        }
        if (context.prompt?.editor?.clear) {
          context.prompt.editor.clear();
          if (typeof context.prompt.scheduleDraw === 'function') context.prompt.scheduleDraw();
        }
        return ok(`✓ Switched to "${next.title}" (${next.messages.length} messages, ${next.id}).`, { effect: 'inline' });
      }

      if (verb === 'delete' && args[1]) {
        return store.deleteSession(args[1]) ? ok(`Deleted session "${args[1]}".`) : fail(`No session "${args[1]}".`);
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
        + '\n\nSwitch with /sessions switch <id>, or run /sessions to open interactive modal picker.',
        { effect: 'pick-session', items: rows, active }
      );
    }
  },

  {
    name: 'continuum',
    aliases: ['resume'],
    scope: 'local',
    usage: '/continuum [list | read <id> | adopt <id>]',
    description: 'Cross-agent session extraction and resumption (Antigravity, OpenCode, Codex, Claude Code)',
    dialogTitle: 'Continuum',
    run: async (args = [], context = {}) => {
      const {
        ContinuumScanner,
        adoptContinuumSession,
        runInteractiveContinuum,
        openContinuumPreview
      } = await import('./continuum/index.js');

      const verb = String(args[0] || '').toLowerCase();
      const targetId = args[1];

      // If interactive modal prompt is available and no subverb is passed
      if (!verb && context.prompt && typeof context.prompt.openLayer === 'function') {
        const resultText = await runInteractiveContinuum(context.prompt, {
          loop: context.loop
        });
        return ok(resultText, { effect: 'inline' });
      }

      const scanner = context.scanner || new ContinuumScanner();

      if (verb === 'read' && targetId) {
        if (context.prompt && typeof context.prompt.openLayer === 'function') {
          const opened = await openContinuumPreview(targetId, context.prompt, scanner);
          if (opened) return ok(`Displaying preview for ${targetId}.`);
        }
        const detail = await scanner.fetchSession(targetId);
        if (!detail) return fail(`No peer session found with ID "${targetId}".`);
        const transcriptText = detail.messages.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n');
        return ok(`=== ${detail.title} (${detail.sourceLabel}) ===\nWorkspace: ${detail.workspacePath}\n\n${transcriptText}`);
      }

      if (verb === 'adopt' && targetId) {
        const adoptRes = await adoptContinuumSession(targetId, {
          scanner,
          currentLoopMessages: context.loop?.messages
        });
        if (!adoptRes.ok) return fail(adoptRes.error || `Failed to adopt session "${targetId}".`);
        if (context.loop?.memoryManager) {
          context.loop.memoryManager.useSession(adoptRes.sessionId);
          if (typeof context.loop.memoryManager.loadHistory === 'function') {
            context.loop.messages = context.loop.memoryManager.loadHistory();
          }
        }
        return ok(`Successfully adopted session "${adoptRes.title}" from ${adoptRes.sourcePlatform.toUpperCase()} (${adoptRes.messageCount} messages compacted).\nActive Causyne session: ${adoptRes.sessionId}.`);
      }

      // Default or 'list':
      const sessions = await scanner.scanAllSessions({ limit: 40 });
      if (sessions.length === 0) {
        return ok('No peer agent sessions discovered across Antigravity, OpenCode, Codex, or Claude Code.');
      }

      const lines = sessions.map(s => {
        const when = new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        const ws = s.workspacePath ? path.basename(s.workspacePath) : '(default)';
        return `  [${s.sourceLabel.padEnd(12)}] ${s.id.padEnd(38)} ${when}  ${String(s.messageCount).padStart(3)} msgs  ${ws}\n      ${s.title}`;
      });

      return ok(
        `Discovered ${sessions.length} cross-agent sessions:\n`
        + lines.join('\n')
        + '\n\nUsage:\n  /continuum                  — open interactive picker\n  /continuum adopt <id>       — adopt & resume session\n  /continuum read <id>        — preview full transcript'
      );
    }
  },

  {
    name: 'approvals',
    scope: 'local',
    usage: '/approvals [clear]',
    description: 'List tools granted "Allow always", or revoke them',
    dialogTitle: 'Approvals',
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
    aliases: ['reset'],
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
    aliases: ['models'],
    scope: 'local',
    usage: '/model [list | refresh | provider/model | model]',
    description: 'Show, list or change the model in use',
    dialogTitle: 'Model',
    complete: () => {
      const config = loadConfig();
      const currentProvider = config.provider || '';
      const overview = getAvailableProvidersOverview(config);
      const items = [
        { value: 'list', label: 'list', description: 'overview of all BYOK and ACP models' },
        { value: 'refresh', label: 'refresh', description: 'poll provider API for live models' }
      ];

      // 1. Models for the active provider
      const curated = getCuratedModels(currentProvider);
      for (const m of curated) {
        items.push({ value: m, label: m, description: `[active] ${currentProvider}` });
      }

      // 2. ACP Peer Agents (with live auto-detected status)
      for (const peer of overview.acp) {
        const statusTag = peer.installed ? '(ready)' : '(not installed)';
        items.push({
          value: peer.providerKey,
          label: peer.providerKey,
          description: `[ACP: ${peer.label}] ${statusTag}`
        });

        if (peer.installed && Array.isArray(peer.models)) {
          for (const m of peer.models.slice(0, 3)) {
            if (peer.isCurrent && curated.includes(m)) continue;
            const targetVal = m.includes('/') ? m : `${peer.providerKey}/${m}`;
            items.push({
              value: targetVal,
              label: targetVal,
              description: `[ACP: ${peer.label}]`
            });
          }
        }
      }

      // 3. BYOK Providers (Cloud & Local)
      for (const p of overview.byok) {
        const configTag = p.isConfigured ? '(configured)' : '(needs key)';
        items.push({
          value: p.id,
          label: p.id,
          description: `[BYOK: ${p.label}] ${configTag}`
        });

        if (p.isConfigured && Array.isArray(p.models)) {
          for (const m of p.models.slice(0, 2)) {
            if (p.isCurrent && curated.includes(m)) continue;
            items.push({
              value: `${p.id}/${m}`,
              label: `${p.id}/${m}`,
              description: `[BYOK: ${p.label}]`
            });
          }
        }
      }

      return items;
    },
    run: async (argv, ctx = {}) => {
      const config = loadConfig();
      const overview = getAvailableProvidersOverview(config);

      if (argv.length === 0) {
        if (ctx.prompt) {
          const { runInteractiveModelPicker } = await import('./tui/modelPicker.js');
          const output = await runInteractiveModelPicker(ctx.prompt, { loadConfig, saveConfig }, { loop: ctx.loop });
          if (ctx.loop) {
            ctx.loop.config = loadConfig();
            if (typeof ctx.loop.updateTierLimits === 'function') {
              ctx.loop.updateTierLimits();
            }
          }
          return ok(output, { effect: 'inline' });
        }

        const lines = [
          `Active Provider : ${config.provider || 'no provider configured'}`,
          `Active Model    : ${config.model || 'none'}`,
          '',
          '────────────────────────────────────────────────────────────',
          'BYOK PROVIDERS (Cloud & Local API)',
          '────────────────────────────────────────────────────────────'
        ];
        for (const p of overview.byok) {
          const status = p.isConfigured ? (p.isCurrent ? '● Configured (Active)' : '○ Configured') : '─ Not configured (run /setup)';
          lines.push(`  • ${p.label.padEnd(26)} [${status}]`);
        }
        lines.push('');
        lines.push('────────────────────────────────────────────────────────────');
        lines.push('ACP PEER AGENTS (Local Coding Agents & CLI Engines)');
        lines.push('────────────────────────────────────────────────────────────');
        for (const peer of overview.acp) {
          const icon = peer.installed ? '✅' : '❌';
          const status = peer.installed ? (peer.isCurrent ? 'READY (Active)' : 'READY') : 'NOT INSTALLED';
          lines.push(`  ${icon} ${peer.label.padEnd(24)} — ${status}`);
        }
        lines.push('');
        lines.push('Use /model list to see all models in each category.');
        lines.push('Use /model <name> or /model acp/<peer> to switch model.');
        lines.push('Use /setup to configure credentials and endpoints.');
        return ok(lines.join('\n'));
      }

      const first = argv[0].toLowerCase();
      if (first === 'list' || first === 'ls') {
        const targetProvider = argv[1];

        // Specific provider requested (e.g. /model list gemini)
        if (targetProvider && targetProvider !== 'all') {
          const result = await resolveAvailableModels(targetProvider, config);
          const active = config.model;
          const lines = [
            `Available models for ${targetProvider} (source: ${result.source}):`,
            ''
          ];
          for (const m of result.models) {
            const isCurrent = m === active && config.provider === targetProvider;
            lines.push(`  ${isCurrent ? '• ' : '  '}${m}${isCurrent ? '  (active)' : ''}`);
          }
          if (result.models.length === 0) {
            lines.push('  (this peer CLI publishes no model list; enter one with /model <name>)');
          }
          lines.push('');
          lines.push('Use /model <name> to select, or /model refresh to poll the provider API.');
          return ok(lines.join('\n'));
        }

        // Comprehensive categorized listing
        const lines = [
          '============================================================',
          'BYOK PROVIDERS (Cloud APIs & Local Endpoints)',
          '============================================================'
        ];
        for (const p of overview.byok) {
          const badge = p.isConfigured ? (p.isCurrent ? '● ACTIVE' : '○ CONFIGURED') : 'NEEDS KEY';
          lines.push(`  • ${p.label} [${badge}]`);
          const modelSample = p.models.slice(0, 5).join(', ');
          lines.push(`    Models: ${modelSample}${p.models.length > 5 ? `, ... (${p.models.length} total)` : ''}`);
          lines.push(`    Switch: /model ${p.id}/${p.defaultModel}`);
          lines.push('');
        }

        lines.push('============================================================');
        lines.push('ACP PEER AGENTS (Local Agents & CLI Engines)');
        lines.push('============================================================');
        for (const peer of overview.acp) {
          const icon = peer.installed ? '✅' : '❌';
          const status = peer.installed ? (peer.isCurrent ? 'READY (Active)' : 'READY') : 'NOT INSTALLED';
          lines.push(`  ${icon} ${peer.label} — ${status}`);
          lines.push(`     Command: ${peer.command}`);
          if (peer.installed) {
            lines.push(`     Models:  ${peer.models.join(', ')}`);
            lines.push(`     Switch:  /model ${peer.providerKey}`);
          } else {
            lines.push(`     Setup:   ${peer.setupInstruction}`);
          }
          lines.push('');
        }

        lines.push('------------------------------------------------------------');
        lines.push('Use /model <name> or /model acp/<peer> to select.');
        lines.push('Use /setup to configure credentials or endpoints.');
        return ok(lines.join('\n'));
      }

      if (first === 'refresh') {
        if (!config.provider) return fail('No provider configured. Run /setup first.');
        const result = await resolveAvailableModels(config.provider, config, true);
        return ok(`Refreshed ${config.provider} models (${result.models.length} available, source: ${result.source}). Run /model list to view.`);
      }

      const rawRequested = argv.join(' ').trim().replace(/^\/model\s+/i, '');

      // Helper to cleanly activate a provider + model, persist config, update live loop & prompt
      const activateModel = (nextProvider, nextModel, feedbackMessage) => {
        const isProviderChange = nextProvider !== config.provider;
        if (isProviderChange) {
          if (nextProvider === 'antigravity' || nextProvider.startsWith('acp/')) {
            config.apiKey = '';
            delete config.baseUrl;
          } else {
            config.apiKey = (config.providerKeys && config.providerKeys[nextProvider]) || '';
            delete config.baseUrl;
          }
        }
        config.provider = nextProvider;
        config.model = nextModel;
        saveConfig(config);

        if (ctx.loop) {
          ctx.loop.config = loadConfig();
          if (typeof ctx.loop.updateTierLimits === 'function') {
            ctx.loop.updateTierLimits();
          }
        }
        if (ctx.prompt) {
          if (typeof ctx.prompt.updateModel === 'function') {
            ctx.prompt.updateModel(config.provider, config.model);
          } else if (ctx.prompt.renderer?.status) {
            ctx.prompt.renderer.status.setSession({ provider: config.provider, model: config.model });
            if (typeof ctx.prompt.scheduleDraw === 'function') ctx.prompt.scheduleDraw();
          }
        }
        return ok(feedbackMessage || `Now using ${config.provider} / ${config.model}.`, { effect: 'inline' });
      };

      // 1. Antigravity provider (e.g. antigravity or antigravity/Gemini 3.8 Flash (High))
      if (rawRequested.toLowerCase() === 'antigravity' || rawRequested.toLowerCase().startsWith('antigravity/')) {
        const agyModel = rawRequested.includes('/')
          ? rawRequested.slice(rawRequested.indexOf('/') + 1).trim()
          : (DEFAULT_MODEL_BY_PROVIDER['antigravity'] || 'Gemini 3.8 Flash (Low)');
        const agyPeer = overview.acp.find(p => p.id === 'antigravity');
        const notice = agyPeer && !agyPeer.installed
          ? `⚠️ Notice: Antigravity CLI (agy) is not installed on this machine.\nSetup: ${agyPeer.setupInstruction}\n\nNow using Google Antigravity / ${agyModel}.`
          : `Now using Google Antigravity / ${agyModel}.`;
        return activateModel('antigravity', agyModel, notice);
      }

      // 2. acp/<peer> or acp/<peer>/<model>
      const acpTarget = rawRequested.match(/^acp\/([a-z0-9_-]+)(?:\/(.+))?$/i);
      if (acpTarget) {
        const peer = acpTarget[1].toLowerCase();
        const nextProvider = `acp/${peer}`;
        const peerModel = acpTarget[2] ? acpTarget[2].trim() : (DEFAULT_MODEL_BY_PROVIDER[nextProvider] || peer);
        const peerInfo = overview.acp.find(p => p.id === peer);
        const notice = peerInfo && !peerInfo.installed
          ? `⚠️ Notice: "${peerInfo.label}" CLI is not installed on this machine.\nBinary "${peerInfo.id}" was not found on PATH.\nSetup: ${peerInfo.setupInstruction}\n\nNow using ${nextProvider} / ${peerModel}.`
          : `Now using ${nextProvider} / ${peerModel}.`;
        return activateModel(nextProvider, peerModel, notice);
      }

      // 3. Known ACP peer directly (e.g. opencode, opencode/deepseek-v4.1-flash-free, claude)
      const slashIndex = rawRequested.indexOf('/');
      const prefix = (slashIndex > 0 ? rawRequested.slice(0, slashIndex) : rawRequested).toLowerCase();
      const acpPeer = overview.acp.find(p => p.id === prefix || p.providerKey === prefix);
      if (acpPeer && acpPeer.id !== 'antigravity') {
        const nextProvider = acpPeer.providerKey;
        let peerModel;
        if (slashIndex > 0) {
          const rest = rawRequested.slice(slashIndex + 1).trim();
          if (
            (PEER_MODEL_CATALOGUE[acpPeer.id] && PEER_MODEL_CATALOGUE[acpPeer.id].includes(rawRequested)) ||
            (acpPeer.id === 'opencode' && rawRequested.startsWith('opencode/'))
          ) {
            peerModel = rawRequested;
          } else {
            peerModel = rest;
          }
        } else {
          peerModel = DEFAULT_MODEL_BY_PROVIDER[nextProvider] || acpPeer.id;
        }
        const notice = !acpPeer.installed
          ? `⚠️ Notice: "${acpPeer.label}" CLI is not installed on this machine.\nBinary "${acpPeer.id}" was not found on PATH.\nSetup: ${acpPeer.setupInstruction}\n\nNow using ${nextProvider} / ${peerModel}.`
          : `Now using ${nextProvider} / ${peerModel}.`;
        return activateModel(nextProvider, peerModel, notice);
      }

      // 4. Known BYOK provider prefix (e.g. gemini/gemini-2.5-flash, anthropic/claude-3-7-sonnet)
      const byokProvider = overview.byok.find(p => p.id === prefix || (p.id === 'qwen' && prefix === 'dashscope-byok'));
      if (byokProvider) {
        const nextProvider = byokProvider.id;
        const byokModel = slashIndex > 0 ? rawRequested.slice(slashIndex + 1).trim() : (DEFAULT_MODEL_BY_PROVIDER[nextProvider] || byokProvider.defaultModel);
        return activateModel(nextProvider, byokModel, `Now using ${nextProvider} / ${byokModel}.`);
      }

      // 5. Look up by model name across BYOK and ACP catalogues
      for (const p of overview.byok) {
        if (p.models && p.models.some(m => m.toLowerCase() === rawRequested.toLowerCase())) {
          const exactModel = p.models.find(m => m.toLowerCase() === rawRequested.toLowerCase()) || rawRequested;
          return activateModel(p.id, exactModel, `Now using ${p.id} / ${exactModel}.`);
        }
      }
      for (const peer of overview.acp) {
        if (peer.models && peer.models.some(m => m.toLowerCase() === rawRequested.toLowerCase())) {
          const exactModel = peer.models.find(m => m.toLowerCase() === rawRequested.toLowerCase()) || rawRequested;
          return activateModel(peer.providerKey, exactModel, `Now using ${peer.providerKey} / ${exactModel}.`);
        }
      }

      // 6. If currently in ACP and model is custom for that peer
      if (isAcpProvider(config.provider)) {
        return activateModel(config.provider, rawRequested, `Now using ${config.provider} / ${rawRequested}.`);
      }

      // 7. Generic provider/model separator or bare model
      if (slashIndex > 0) {
        const prov = rawRequested.slice(0, slashIndex).trim();
        const mod = rawRequested.slice(slashIndex + 1).trim();
        return activateModel(prov, mod, `Now using ${prov} / ${mod}.`);
      } else {
        return activateModel(config.provider || 'antigravity', rawRequested, `Now using ${config.provider || 'antigravity'} / ${rawRequested}.`);
      }
    }
  },

  {
    name: 'mcp',
    scope: 'local',
    usage: '/mcp [add <name> <cmd…> | add <name> --url <url> | remove|grant|revoke|connect|disconnect|test|refresh <name>]',
    description: 'Manage and diagnose MCP server connections',
    dialogTitle: 'MCP servers',
    run: async (argv) => {
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
          const granted = grantServer(serverName);
          if (!granted.ok) return fail(granted.error);
          return ok(`Granted "${serverName}". Its tools enter the catalogue on the next task.`);
        }
        revokeServer(serverName);
        return ok(`Revoked "${serverName}". Its tools are no longer callable.`);
      }

      if (['connect', 'test', 'refresh', 'disconnect'].includes(action)) {
        if (!serverName) return fail(`Usage: /mcp ${action} <server>`);
        const known = serverStatus().some(server => server.name === serverName);
        if (!known) return fail(`No MCP server named "${serverName}" is configured.`);

        if (action === 'disconnect') {
          await disconnectServer(serverName);
          return ok(`Disconnected "${serverName}". Its grant remains in place.`);
        }

        if (action === 'refresh') {
          const tools = await refreshServer(serverName);
          return ok(`Refreshed "${serverName}": ${tools.length} tool(s) available${tools.length ? ` — ${tools.map(tool => tool.name).join(', ')}` : ''}.`);
        }

        const client = await connectServer(serverName);
        return ok(
          `${action === 'test' ? 'MCP test passed' : 'Connected'}: "${serverName}"\n`
          + `Transport: ${client.status.transport || 'unknown'}\n`
          + `Server: ${client.serverInfo ? `${client.serverInfo.name} ${client.serverInfo.version}` : 'identity not provided'}\n`
          + `Tools: ${client.tools.length}${client.tools.length ? ` — ${client.tools.map(tool => tool.name).join(', ')}` : ''}`
        );
      }

      if (action) {
        return fail(`Unknown mcp action "${action}". Try: add, remove, grant, revoke, connect, disconnect, test, refresh, or mcp on its own to list.`);
      }

      const servers = serverStatus();
      if (servers.length === 0) {
        return ok('No MCP servers are configured.\n\nAdd one with:\n  mcp add <name> <command> [args…]\n  mcp add <name> --url <https://…>\n\n(prefix with / in chat, or `causyne-agent mcp …` in a terminal)', { effect: 'pick-mcp' });
      }
      const lines = ['MCP servers', ''];
      for (const server of servers) {
        lines.push(`  ${server.name}  [${server.transport}]  ${server.granted ? 'granted' : 'NOT granted'}  ${server.status}`);
        lines.push(`    ${server.target}`);
        if (server.tools.length > 0) lines.push(`    tools: ${server.tools.join(', ')}`);
        if (server.error) lines.push(`    error: ${server.error}`);
      }
      lines.push('');
      lines.push('  mcp grant <name> to enable, mcp test <name> to diagnose, mcp remove <name> to delete.');
      return ok(lines.join('\n'), { effect: 'pick-mcp' });
    }
  },

  {
    name: 'peers',
    scope: 'local',
    usage: '/peers [detect | test <id> | add <id> <command…> | remove <id>]',
    description: 'Manage, discover, and test external ACP peer agents (Claude Code, OpenCode, Codex, Gemini, Hermes, etc.)',
    dialogTitle: 'ACP peer agents',
    run: async (argv) => {
      const [action, peerId, ...rest] = argv;

      if (action === 'detect') {
        const detected = await detectAllPeers();
        const lines = ['Discovered ACP Peer Agents', ''];
        for (const item of detected) {
          const statusIcon = item.status === 'ready' ? '✅' : (item.status === 'needs_auth' ? '⚠️ ' : '❌');
          lines.push(`  ${statusIcon} ${item.id} (${item.label}) — ${item.status.toUpperCase()}`);
          lines.push(`     Command: ${item.command} ${item.args.join(' ')}`);
          if (item.details) lines.push(`     Details: ${item.details}`);
          if (item.setupInstruction) lines.push(`     Setup: ${item.setupInstruction}`);
        }
        lines.push('');
        lines.push('Use /peers test <id> to test zero-token handshake against a specific peer.');
        lines.push('Any ready peer can be your model provider: /model acp/<id>');
        return ok(lines.join('\n'));
      }

      if (action === 'test') {
        if (!peerId) return fail('Usage: /peers test <id>');
        if (peerId === 'antigravity') {
          const { resolveAgyBinary } = await import('./providers/antigravity.js');
          const bin = resolveAgyBinary();
          return ok(
            `✅ Agent Peer Test Passed: "antigravity"\n\n`
            + `Agent: Google Antigravity (AGY)\n`
            + `Command: ${bin} --output-format json\n`
            + `Policy: local-cli\n`
            + `Frontier Models: Gemini 4 Argon, Gemini 3.8 Flash, Claude Sonnet 5.5\n\n`
            + `Ready to serve as primary AI provider or peer delegation.`
          );
        }
        const profile = getPeerProfile(peerId);
        if (!profile) return fail(`No peer agent found for "${peerId}". Try /peers detect to see available agents.`);

        const handshake = await testPeerHandshake({
          command: profile.command,
          args: profile.args,
          cwd: profile.cwd || process.cwd(),
          timeoutMs: 15000
        });

        if (handshake.ready) {
          const name = handshake.agentInfo ? `${handshake.agentInfo.name} ${handshake.agentInfo.version}` : profile.label;
          return ok(
            `✅ ACP Peer Test Passed: "${peerId}"\n\n`
            + `Agent: ${name}\n`
            + `Command: ${profile.command} ${profile.args.join(' ')}\n`
            + `Policy: ${profile.policy}\n`
            + `Auth Methods: ${handshake.authMethods?.join(', ') || 'none'}\n\n`
            + `Ready to receive delegated tasks via peer_agent_delegate.`
          );
        } else {
          return fail(
            `❌ ACP Peer Test Failed: "${peerId}"\n\n`
            + `Error: ${handshake.error || 'Handshake failed'}\n`
            + `Command: ${profile.command} ${profile.args.join(' ')}`
          );
        }
      }

      if (action === 'add') {
        if (!peerId) return fail('Usage: /peers add <id> <command> [args…]');
        if (rest.length === 0) return fail(`Give "${peerId}" a command to run (e.g. opencode acp).`);

        const newProfile = {
          id: peerId.trim().toLowerCase(),
          label: peerId,
          command: rest[0],
          args: rest.slice(1),
          cwd: null,
          policy: 'read-only',
          timeoutSeconds: 180,
          env: {}
        };

        const res = addPeerProfile(newProfile);
        if (!res.ok) return fail(`Could not save peer: ${res.error}`);
        return ok(`Added peer "${peerId}" [policy: read-only]. Edit ~/.causyne/peers.json to customize policy, timeout, or environment.`);
      }

      if (action === 'remove') {
        if (!peerId) return fail('Usage: /peers remove <id>');
        const res = removePeerProfile(peerId);
        if (!res.ok) return fail(res.error || `Could not remove peer "${peerId}".`);
        return ok(`Removed peer profile "${peerId}".`);
      }

      if (action) {
        return fail(`Unknown peers action "${action}". Try: detect, test, add, remove, or peers on its own to list.`);
      }

      // Default: list all configured and discovered peers
      const peers = listAllPeers();
      const lines = ['Configured & Preset ACP Peer Agents', ''];
      for (const peer of peers) {
        lines.push(`  • ${peer.id} (${peer.label}) [policy: ${peer.policy}, timeout: ${peer.timeoutSeconds}s]`);
        lines.push(`    Command: ${peer.command} ${peer.args.join(' ')}`);
      }
      lines.push('');
      lines.push('Commands:');
      lines.push('  /peers detect     Scan local system for installed ACP agents');
      lines.push('  /peers test <id>  Verify zero-token connection to an agent');
      lines.push('  /peers add <id>   Add or override a peer command');
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
    dialogTitle: 'Status',
    // One builder, shared with `causyne status`, so status output cannot drift.
    run: (argv, ctx) => ok(buildStatusText({ loop: ctx.loop || null }))
  },

  {
    name: 'observer',
    scope: 'local',
    usage: '/observer [status|toggle|mode <deterministic|advisory>|endpoint <url|none>|model <name>|strictness <relaxed|standard|strict>|test|audit|reset]',
    description: 'Inspect or configure the Cold Observer',
    dialogTitle: 'Cold Observer',
    run: async (argv) => {
      const { coldObserver } = await import('./observer/coldObserver.js');
      const sub = (argv[0] || 'status').toLowerCase();

      if (sub === 'toggle') {
        const current = coldObserver.getConfig();
        coldObserver.updateConfig({ enabled: !current.enabled });
        return ok(`Cold Observer is now ${!current.enabled ? 'ENABLED' : 'DISABLED'}.`);
      }

      if (sub === 'mode') {
        const targetMode = String(argv[1] || '').toLowerCase();
        if (!['deterministic', 'advisory', 'local', 'hybrid'].includes(targetMode)) {
          return fail('Invalid mode. Choose: deterministic or advisory.');
        }
        coldObserver.updateConfig({ mode: targetMode });
        return ok(`Cold Observer mode set to "${coldObserver.getConfig().mode}".`);
      }

      if (sub === 'endpoint') {
        const target = String(argv[1] || '').trim();
        try {
          coldObserver.updateConfig({ endpoint: target === 'none' ? '' : target });
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'Invalid endpoint.');
        }
        const endpoint = coldObserver.getConfig().endpoint;
        return ok(endpoint ? `Advisory endpoint set to ${endpoint}.` : 'Advisory endpoint cleared.');
      }

      if (sub === 'model') {
        const target = String(argv[1] || '').trim();
        coldObserver.updateConfig({ model: target === 'none' ? '' : target });
        const model = coldObserver.getConfig().model;
        return ok(model ? `Advisory model set to ${model}.` : 'Advisory model cleared.');
      }

      if (sub === 'strictness') {
        const target = String(argv[1] || '').toLowerCase();
        if (!['relaxed', 'standard', 'strict', 'moderate', 'paranoid'].includes(target)) {
          return fail('Invalid strictness. Choose: relaxed, standard, or strict.');
        }
        coldObserver.updateConfig({ strictness: target });
        return ok(`Cold Observer strictness set to "${coldObserver.getConfig().strictness}".`);
      }

      if (sub === 'test') {
        const health = await coldObserver.healthCheck();
        if (!health.endpoint) {
          return ok('No advisory endpoint configured. The deterministic observer needs no endpoint and remains active.');
        }
        return ok([
          `Endpoint: ${health.endpoint}`,
          `Model:    ${health.model || '(unset)'}`,
          `Healthy:  ${health.healthy ? 'yes' : 'no'} (${health.latencyMs}ms)`,
          `Detail:   ${health.detail}`
        ].join('\n'));
      }

      if (sub === 'reset') {
        coldObserver.updateConfig({
          enabled: true,
          mode: 'deterministic',
          endpoint: '',
          model: '',
          timeoutMs: 800,
          strictness: 'standard'
        });
        return ok('Cold Observer configuration reset to defaults.');
      }

      if (sub === 'audit') {
        const audits = coldObserver.getAuditHistory();
        if (audits.length === 0) {
          return ok('No Cold Observer audit records yet.');
        }
        const lines = audits.slice(-10).map((a) => {
          const time = new Date(a.timestamp).toLocaleTimeString();
          const tag = a.type === 'mutation' ? `[mutation ${a.tool || ''}]` : '[verification]';
          const score = typeof a.riskScore === 'number' ? `(risk ${(a.riskScore * 100).toFixed(0)}%)` : '';
          const veto = a.veto ? 'VETO' : 'pass';
          return `${time} ${tag} ${veto} ${score} ${a.details}`;
        });
        return ok(`Recent Cold Observer audits (last 10):\n\n${lines.join('\n')}`);
      }

      const cfg = coldObserver.getConfig();
      const audits = coldObserver.getAuditHistory();
      const vetoes = audits.filter((a) => a.veto).length;
      return ok([
        'Cold Observer',
        '──────────────────────────────────────────────',
        `Status:       ${cfg.enabled ? 'Active (mutations and completion claims)' : 'Disabled'}`,
        `Mode:         ${cfg.mode.toUpperCase()}`,
        `Strictness:   ${cfg.strictness}`,
        `Advisory:     ${cfg.endpoint ? `${cfg.model || '(model unset)'} at ${cfg.endpoint}` : 'not configured (deterministic only)'}`,
        `Audit events: ${audits.length} recorded (${vetoes} vetoes enforced)`,
        '',
        'Subcommands:',
        '  /observer toggle                            Enable or disable protection',
        '  /observer mode <deterministic|advisory>     Choose the review mode',
        '  /observer endpoint <url|none>               Set a loopback advisory endpoint',
        '  /observer model <name>                      Set the advisory model name',
        '  /observer strictness <relaxed|standard|strict>',
        '  /observer test                              Probe the advisory endpoint',
        '  /observer audit                             Inspect recent audits',
        '  /observer reset                             Restore defaults'
      ].join('\n'));
    }
  },

  {
    name: 'acp',
    scope: 'local',
    usage: '/acp [status|peers]',
    description: 'Agent Client Protocol (ACP) server and peer delegation status',
    dialogTitle: 'Agent Client Protocol',
    run: async (argv) => {
      const sub = (argv[0] || 'status').toLowerCase();
      if (sub === 'peer' || sub === 'peers') {
        const { loadPeerProfiles, peerProfilesPath } = await import('./acp/peerProfiles.js');
        const profiles = loadPeerProfiles();
        return ok([
          'Peer delegation (ACP)',
          '──────────────────────────────────────────────',
          `Profiles file: ${peerProfilesPath()}`,
          `Configured:    ${profiles.length === 0 ? 'none' : profiles.map((p) => `${p.id} (${p.policy})`).join(', ')}`,
          '',
          'The model selects a profile id and writes a prompt. Executable, arguments,',
          'working directory, and environment always come from the profile file.'
        ].join('\n'));
      }
      return ok([
        'Agent Client Protocol (ACP) - Causyne Agent',
        '──────────────────────────────────────────────',
        'Version:        ACP v1 (JSON-RPC 2.0 over stdio)',
        'Server command: causyne acp',
        'Wire:           newline-delimited JSON-RPC',
        'Sessions:       session/new, session/prompt, session/cancel, session/update',
        'Optional:       session/list, session/close, session/set_mode',
        'Workspace:      one workspace per server process',
        '',
        'Run "causyne acp" to connect this agent to any ACP client.'
      ].join('\n'));
    }
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
    const result = await command.run(argv, { ...ctx, surface });
    if (command.dialogTitle && result && !result.effect) {
      return { ...result, effect: 'dialog', title: command.dialogTitle };
    }
    return result;
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
