---
name: cli-tool-construction
description: Build a Python command-line tool. Use when a script parses sys.argv by hand, when it has no help output, or when it cannot be used in a pipeline.
---

# Python CLI Construction

## What separates a tool from a script

Discoverable help, correct exit codes, stdout carrying only the result, and behaviour that composes with other tools. A script that prints progress to stdout cannot be piped, and that is usually the first thing a user tries.

## Workflow

1. Use a parser, not manual argument handling.
   - `argparse` is in the standard library and sufficient. `typer` or `click` add ergonomics at the cost of a dependency.
   - Every option gets a help string. `--help` is the tool's primary documentation.
   - **Done when:** `--help` alone explains how to use the tool.

2. Separate the streams.
   - Results to stdout. Progress, warnings and errors to stderr. Mixing them makes the tool unpipeable and its output unparseable.
   - **Done when:** `tool ... > out.txt` leaves a file containing only results, with progress still visible on the terminal.

3. Exit with meaning.
   - 0 for success, non-zero for failure. A tool that exits 0 after failing breaks every script that calls it.
   - **Done when:** a deliberate failure produces a non-zero exit code.

4. Read from stdin when no file is given.
   - `-` conventionally means stdin. This makes the tool a filter and lets it compose.
   - **Done when:** `cat file | tool` behaves as `tool file`.

5. Keep the logic out of the entry point.
   - `main()` parses arguments and calls a function that takes plain values. That function is testable without spawning a process.
   - **Done when:** the core behaviour has tests that do not invoke the CLI.

6. Handle interruption quietly.
   - Catch the keyboard interrupt at the top level and exit 130 without a traceback. A stack trace on Ctrl+C looks like a crash.
   - **Done when:** interrupting prints nothing alarming and exits 130.

## Verification

- `--help` documents every option.
- Redirecting stdout captures only results.
- A failure path exits non-zero.
- The core logic has tests that bypass argument parsing.
