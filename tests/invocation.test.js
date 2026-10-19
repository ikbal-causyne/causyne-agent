// Bare-root detection: does this argv open the application, or run a subcommand?
//
// This replaced `process.argv.length <= 2`, and the danger runs in two
// directions. Too eager and a real subcommand gets swallowed by the home screen,
// which would make the CLI unscriptable; too shy and the product's own root
// flags are reported as invalid commands. Both directions are pinned here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInvocation, isBareRoot, ROOT_OPTIONS } from '../src/tui/invocation.js';

/** argv as Node hands it over: [execPath, scriptPath, ...args]. */
const argv = (...args) => ['/usr/bin/node', '/usr/local/bin/causyne', ...args];

describe('bare root opens the application', () => {
  test('no arguments at all', () => {
    assert.equal(isBareRoot(argv()), true);
  });

  test('a known root option is still bare', () => {
    // The regression the old length check produced: `causyne --dev-emulator` is
    // the product's own flag, and it was answered with "Invalid command".
    assert.equal(isBareRoot(argv('--dev-emulator')), true);
    assert.deepEqual(resolveInvocation(argv('--dev-emulator')).rootOptions, ['--dev-emulator']);
  });

  test('everything after `--` is an operand, not a command', () => {
    assert.equal(isBareRoot(argv('--', 'start')), true);
  });
});

describe('anything else goes to the dispatcher', () => {
  test('a subcommand is never swallowed', () => {
    for (const name of ['start', 'stop', 'chat', 'pair', 'status', 'undo', 'mcp', 'run']) {
      const result = resolveInvocation(argv(name));
      assert.equal(result.isBareRoot, false, `${name} must reach Commander`);
      assert.equal(result.primary, name);
    }
  });

  test('help and version print rather than launch', () => {
    for (const flag of ['-h', '--help', '-V', '--version']) {
      const result = resolveInvocation(argv(flag));
      assert.equal(result.isBareRoot, false, `${flag} must not open the home screen`);
      assert.equal(result.hasHelpOrVersion, true);
    }
  });

  test('an unknown option is Commander’s to reject, not ours to ignore', () => {
    // Opening the home screen on `causyne --nonsense` would silently swallow a
    // typo. The user must be told.
    const result = resolveInvocation(argv('--nonsense'));
    assert.equal(result.isBareRoot, false);
    assert.equal(result.unknownOption, '--nonsense');
  });

  test('a root option before a subcommand still finds the subcommand', () => {
    const result = resolveInvocation(argv('--dev-emulator', 'chat'));
    assert.equal(result.primary, 'chat');
    assert.equal(result.isBareRoot, false);
  });

  test('a task that mentions an absolute path is not mistaken for an option', () => {
    const result = resolveInvocation(argv('run', '/usr/local/bin'));
    assert.equal(result.primary, 'run');
    assert.equal(result.isBareRoot, false);
  });
});

describe('the walker itself', () => {
  test('`--opt=value` consumes no extra slot', () => {
    // If the inline form were treated as taking a following argument, the token
    // after it would be eaten and a subcommand could go missing.
    ROOT_OPTIONS.set('--profile', 1);
    try {
      assert.equal(resolveInvocation(argv('--profile=work', 'start')).primary, 'start');
      assert.equal(resolveInvocation(argv('--profile', 'work', 'start')).primary, 'start');
    } finally {
      ROOT_OPTIONS.delete('--profile');
    }
  });

  test('a malformed argv never throws', () => {
    for (const bad of [null, undefined, [], ['node'], argv('')]) {
      assert.doesNotThrow(() => resolveInvocation(bad));
    }
  });
});
