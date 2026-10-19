// P3 — the shared slash-command registry.
//
// These tests pin the local command table plus the parsing rule that decides whether a line is a
// command or a task for the agent — get that wrong and either every command is
// sent to the LLM as prose, or a prompt mentioning an absolute path gets eaten
// as a bad command.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const SANDBOX_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cmd-')));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const {
  COMMANDS,
  parseCommand,
  isCommandInput,
  resolveCommand,
  listCommands,
  runCommand,
  handleInput
} = await import('../src/commands.js');

after(() => {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_USERPROFILE;
  try { fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch (e) {}
});

describe('parsing: command or task?', () => {
  test('a leading slash with a letter is a command', () => {
    assert.deepEqual(parseCommand('/help'), { name: 'help', argv: [], raw: '/help' });
    assert.deepEqual(parseCommand('  /undo --step  ').argv, ['--step']);
    assert.equal(parseCommand('/skills python/ai-frameworks-2024').argv[0], 'python/ai-frameworks-2024');
  });

  test('an absolute path is NOT a command', () => {
    // "delete everything in /usr/local/tmp" must reach the agent as a task, and
    // a bare path pasted on its own must not be swallowed as a bad command.
    assert.equal(parseCommand('/usr/local/bin'), null);
    assert.equal(parseCommand('/Users/example/Causyne'), null);
    assert.equal(isCommandInput('/etc/hosts'), false);
  });

  test('plain prose is not a command', () => {
    assert.equal(parseCommand('build me a landing page'), null);
    assert.equal(parseCommand('what is 2+2'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand('/'), null);
    assert.equal(parseCommand(null), null);
  });

  test('/? resolves to help', () => {
    assert.equal(parseCommand('/?').name, '?');
    assert.equal(resolveCommand('?').name, 'help');
  });

  test('command names are case-insensitive', () => {
    assert.equal(parseCommand('/HELP').name, 'help');
    assert.equal(resolveCommand('CtX').name, 'context');
  });
});

describe('the registry is coherent', () => {
  test('every command declares the fields both surfaces render', () => {
    for (const command of COMMANDS) {
      assert.ok(command.name, 'a command needs a name');
      assert.ok(command.usage, `${command.name} needs a usage string`);
      assert.ok(command.description, `${command.name} needs a description`);
      assert.equal(command.scope, 'local', `${command.name} must be terminal-only`);
      assert.equal(typeof command.run, 'function', `${command.name} needs a run()`);
    }
  });

  test('no name or alias is claimed twice', () => {
    const seen = new Set();
    for (const command of COMMANDS) {
      for (const label of [command.name, ...(command.aliases || [])]) {
        assert.ok(!seen.has(label), `"${label}" is registered more than once`);
        seen.add(label);
      }
    }
  });

  test('usage strings start with their own command name', () => {
    for (const command of COMMANDS) {
      assert.ok(command.usage.startsWith(`/${command.name}`),
        `${command.name}: usage "${command.usage}" does not match the command`);
    }
  });

  test('help lists exactly what the surface can run', () => {
    const terminal = listCommands('terminal').map(c => c.name);
    assert.ok(terminal.includes('exit'), '/exit is a terminal affordance');
    for (const shared of ['help', 'undo', 'skills', 'context', 'usage', 'clear', 'mcp']) {
      assert.ok(terminal.includes(shared), `${shared} should be available locally`);
    }
    assert.deepEqual(listCommands('phone'), [], 'remote command surfaces are held out of the runtime');
  });
});

describe('scope is enforced, not just advertised', () => {
  test('a local command is refused on any non-terminal surface', async () => {
    const result = await runCommand('exit', [], { surface: 'phone' });
    assert.equal(result.ok, false);
    assert.match(result.output, /not available on this surface/);
  });

  test('the same local command works in the terminal', async () => {
    const result = await runCommand('exit', [], { surface: 'terminal' });
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'exit');
  });
});

describe('commands behave', () => {
  test('/help renders every visible command', async () => {
    const result = await runCommand('help', [], { surface: 'terminal' });
    assert.equal(result.ok, true);
    for (const command of listCommands('terminal')) {
      assert.ok(result.output.includes(command.usage), `/help omitted ${command.name}`);
    }
  });

  test('/help <command> explains one command', async () => {
    const result = await runCommand('help', ['undo'], { surface: 'terminal' });
    // /undo previews by default now and needs --apply to write, so the flag
    // help must document is the destructive one. It used to be --dry-run,
    // back when typing /undo restored files immediately.
    assert.match(result.output, /--apply/);
  });

  test('a bare /undo never reports writing anything', async () => {
    // A command must not let one word overwrite a day's work. Typing
    // /undo used to restore files immediately — no preview, no confirmation,
    // and none of the running-task guard the button in the app has.
    const result = await runCommand('undo', [], { surface: 'terminal' });
    assert.ok(!/\brestored\b|\bremoved\b/i.test(result.output),
      `a bare /undo must not write; got: ${result.output}`);
  });

  test('the destructive form must be named explicitly', () => {
    // The flag that writes is --apply. Preview is what you get for free.
    const undo = listCommands('terminal').find((c) => c.name === 'undo');
    assert.ok(undo, '/undo must be available on the terminal surface');
    assert.match(undo.usage, /--apply/, 'writing must be opt-in and documented');
    assert.ok(!/--dry-run/.test(undo.usage),
      'preview is the default, so a --dry-run flag would be misleading');
  });

  test('/help on an unknown command says so', async () => {
    const result = await runCommand('help', ['nonsense'], { surface: 'terminal' });
    assert.equal(result.ok, false);
  });

  test('/skills lists the compiled domains', async () => {
    const result = await runCommand('skills', [], { surface: 'terminal' });
    assert.equal(result.ok, true);
    assert.match(result.output, /devops|python|git/);
    assert.doesNotMatch(result.output, /agent-docs/, "internal doctrine must never appear in /skills");
  });

  test('/skills <domain>/<id> INVOKES the skill rather than printing it', async () => {
    // The reported failure: this command printed the whole SKILL.md to the
    // terminal and that was its entire effect. The body never entered a request,
    // no API call was made, and everything typed after the id was discarded — so
    // "activating" a skill did nothing at all.
    const listing = await runCommand('skills', [], { surface: 'terminal' });
    const match = listing.output.match(/^\s{4}([a-z-]+\/[a-z0-9-]+)/mi);
    assert.ok(match, 'expected at least one skill in the listing');

    const result = await runCommand('skills', [match[1]], { surface: 'terminal' });
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'invoke-skill',
      'without an effect the caller has nothing to run — the command is a dead end');
    assert.equal(result.skill.id, match[1]);
    assert.ok(result.skill.content.length > 100, 'the body must travel with the invocation');
  });

  test('everything after the skill id is the task, not discarded', async () => {
    const listing = await runCommand('skills', [], { surface: 'terminal' });
    const id = listing.output.match(/^\s{4}([a-z-]+\/[a-z0-9-]+)/mi)[1];

    const result = await runCommand('skills', [id, 'please', 'produce', 'this'], { surface: 'terminal' });
    assert.equal(result.instruction, 'please produce this',
      'the instruction used to be dropped on the floor: argv[0] was read and the rest ignored');
  });

  test('--show reads a skill as a document, without the frontmatter', async () => {
    const listing = await runCommand('skills', [], { surface: 'terminal' });
    const id = listing.output.match(/^\s{4}([a-z-]+\/[a-z0-9-]+)/mi)[1];

    const result = await runCommand('skills', [id, '--show'], { surface: 'terminal' });
    assert.equal(result.ok, true);
    assert.equal(result.effect, undefined, 'reading must not run anything');
    assert.ok(result.output.length > 100);
    assert.ok(!result.output.startsWith('---'),
      'routing metadata is for the agent; printing it is why an invoked skill looked like a file dump');
  });

  test('/skills on an unknown domain fails clearly', async () => {
    const result = await runCommand('skills', ['not-a-domain'], { surface: 'terminal' });
    assert.equal(result.ok, false);
    assert.match(result.output, /No skill domain/);
  });

  test('/context and /usage produce reports', async () => {
    const context = await runCommand('context', [], { surface: 'terminal' });
    assert.match(context.output, /Context accounting/);

    const usage = await runCommand('usage', [], { surface: 'terminal' });
    assert.match(usage.output, /Token usage/);
  });

  test('/status reports the workspace scope when a session is attached', async () => {
    const result = await runCommand('status', [], {
      surface: 'terminal',
      loop: { sandbox: { grantAllAccess: false, workspacePaths: ['/tmp/demo'] } }
    });
    assert.match(result.output, /\/tmp\/demo/);
  });

  test('/clear resets the attached session', async () => {
    let cleared = false;
    const loop = {
      messages: [{ role: 'user', content: 'x' }],
      unlockedPacks: new Set(['game']),
      unlockedTools: new Set(['godot_act']),
      unlockOrder: ['game'],
      staticContext: {},
      isInitialized: true,
      memoryManager: { clearHistory: () => { cleared = true; } }
    };
    const result = await runCommand('clear', [], { surface: 'terminal', loop });

    assert.equal(result.ok, true);
    assert.equal(loop.messages.length, 0);
    assert.equal(loop.unlockedPacks.size, 0);
    assert.equal(loop.isInitialized, false);
    assert.equal(cleared, true, 'persisted history must be cleared too');
  });

  test('/stop aborts the attached session', async () => {
    let aborted = false;
    const result = await runCommand('stop', [], { surface: 'terminal', loop: { abort: () => { aborted = true; } } });
    assert.equal(aborted, true);
    assert.equal(result.ok, true);
  });

  test('/clear and /stop report honestly with no session', async () => {
    assert.equal((await runCommand('clear', [], { surface: 'terminal' })).ok, false);
    assert.equal((await runCommand('stop', [], { surface: 'terminal' })).ok, false);
  });

  test('/mcp lists configured servers', async () => {
    const result = await runCommand('mcp', [], { surface: 'terminal' });
    assert.equal(result.ok, true);
  });

  test('/mcp grant refuses a server that is not configured', async () => {
    const result = await runCommand('mcp', ['grant', 'no-such-server'], { surface: 'terminal' });
    assert.equal(result.ok, false);
    assert.match(result.output, /No MCP server named/);
  });

  test('/mcp rejects an unknown action rather than guessing', async () => {
    const result = await runCommand('mcp', ['destroy', 'x'], { surface: 'terminal' });
    assert.equal(result.ok, false);
  });
});

describe('it never throws at the surface', () => {
  test('an unknown command reports instead of throwing', async () => {
    const result = await runCommand('definitely-not-a-command', [], { surface: 'terminal' });
    assert.equal(result.ok, false);
    assert.match(result.output, /Unknown command/);
  });

  test('a command that throws internally is caught and reported', async () => {
    const exploding = { name: 'boom', scope: 'local', usage: '/boom', description: 'x', run: () => { throw new Error('kaboom'); } };
    COMMANDS.push(exploding);
    try {
      const result = await runCommand('boom', [], { surface: 'terminal' });
      assert.equal(result.ok, false);
      assert.match(result.output, /kaboom/);
    } finally {
      COMMANDS.pop();
    }
  });

  test('handleInput returns null for a task so the caller sends it to the agent', async () => {
    assert.equal(await handleInput('build me a website', { surface: 'terminal' }), null);
    assert.equal(await handleInput('/usr/bin/env', { surface: 'terminal' }), null);
    assert.ok(await handleInput('/help', { surface: 'terminal' }));
  });
});
