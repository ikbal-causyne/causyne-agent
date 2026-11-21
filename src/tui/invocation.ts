// Deciding whether an argv is "the bare command" or "a subcommand".
//
// This existed as `process.argv.length <= 2` in entrypoint.js, which is right
// only for the exact string `causyne`. The moment a root option is added — and
// `--dev-emulator` is already one on five subcommands — `causyne --dev-emulator`
// stops being bare and falls through to Commander, which reports it as an
// invalid command. The user typed the product's own flag and was told the
// product does not exist.
//
// So the classification walks argv properly: consume declared root options
// together with their values, then look at what bare words are left. Zero words
// and no help/version request means the user asked for the application itself.
//
// Two rules keep this conservative, because getting it wrong in the other
// direction is worse — swallowing a real subcommand into the home screen would
// make the CLI unscriptable:
//
//   1. An option this table does not know about is NOT bare. `causyne --nonsense`
//      goes to Commander so Commander can report it, exactly as it does today.
//   2. `--` ends the scan. Anything after it is operands, not a command path.
//
// Modelled on openclaw's getRootOptionAwareCommandPath, which exists for the
// same reason: `openclaw --profile foo` must still launch the TUI.

/**
 * Root options, and how many argv slots each consumes AFTER itself.
 *
 * Only options accepted BEFORE a subcommand belong here. A flag declared on a
 * subcommand (`causyne start --dev-emulator`) is Commander's business — it is
 * never seen by this walker, because the bare word `start` stops the scan.
 */
export const ROOT_OPTIONS: Map<string, number> = new Map([
  ['-h', 0],
  ['--help', 0],
  ['-V', 0],
  ['--version', 0],
  ['-C', 1],
  ['--cwd', 1],
  ['--dev-emulator', 0]
]);

/** Options that mean "print something and exit", never "launch the app". */
const HELP_OR_VERSION = new Set(['-h', '--help', '-V', '--version']);

export interface InvocationResolution {
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  rootOptions: string[];
  unknownOption: string | null;
  isBareRoot: boolean;
}

/**
 * Classify a full process.argv.
 */
export function resolveInvocation(argv: readonly unknown[] = []): InvocationResolution {
  const tokens = Array.isArray(argv) ? argv.slice(2) : [];
  const commandPath: string[] = [];
  const rootOptions: string[] = [];
  let hasHelpOrVersion = false;
  let unknownOption: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw == null) continue;
    const token = String(raw);

    // Everything past `--` is an operand by POSIX convention. Stop looking for
    // a command name; whatever we have collected is the answer.
    if (token === '--') break;

    if (token.startsWith('-') && token !== '-') {
      // `--opt=value` carries its value inline, so it consumes no extra slot.
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);

      if (HELP_OR_VERSION.has(name)) {
        hasHelpOrVersion = true;
        rootOptions.push(name);
        continue;
      }

      const arity = ROOT_OPTIONS.get(name);
      if (arity !== undefined) {
        rootOptions.push(name);
        // Skip the value only when it was not written inline.
        if (eq === -1 && arity > 0) i = Math.min(tokens.length - 1, i + arity);
        continue;
      }

      // Rule 1: an option we do not recognise is Commander's to reject. Record
      // the first one so the caller can explain itself if it wants to.
      if (unknownOption === null) unknownOption = name;
      continue;
    }

    commandPath.push(token);
    // One bare word is all that is needed to know this is not the bare command.
    break;
  }

  return {
    commandPath,
    primary: commandPath[0] ?? null,
    hasHelpOrVersion,
    rootOptions,
    unknownOption,
    isBareRoot: commandPath.length === 0 && !hasHelpOrVersion && unknownOption === null
  };
}

/** The one question entrypoint.js asks: should this argv open the home screen? */
export function isBareRoot(argv: readonly unknown[] = []): boolean {
  return resolveInvocation(argv).isBareRoot;
}
