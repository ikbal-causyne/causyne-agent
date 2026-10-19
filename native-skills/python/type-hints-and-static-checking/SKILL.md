---
name: type-hints-and-static-checking
description: Add or fix type annotations in Python. Use when a codebase has no hints, when a type checker reports many errors, or when a function signature is ambiguous.
---

# Type Hints and Static Checking

## Where annotations pay

Public function signatures and data structures. Annotating every local variable adds noise without adding information — the checker infers those.

## Workflow

1. Turn the checker on before writing annotations.
   - `mypy` or `pyright`. Start non-strict on an existing codebase; a first run in strict mode on untyped code produces thousands of errors and gets switched off.
   - **Done when:** the checker runs and its current error count is recorded.

2. Annotate boundaries first.
   - Public functions, class attributes, and anything crossing a module edge. This is where a wrong assumption actually costs something.
   - **Done when:** every public function has annotated parameters and a return type.

3. Use the modern syntax.
   - `list[str]` not `List[str]`. `str | None` not `Optional[str]`. `dict[str, int]` not `Dict[str, int]`. The `typing` aliases are deprecated.
   - **Done when:** no import from `typing` exists that a builtin generic replaces.

4. Never reach for `Any` to silence an error.
   - `Any` disables checking for everything it touches and spreads. If the type is genuinely unknown, `object` is honest and forces a narrowing check at the point of use.
   - **Done when:** every remaining `Any` has a comment saying why.

5. Ratchet strictness upward.
   - Enable one strict flag at a time and fix the errors it produces. `disallow_untyped_defs` module by module via per-module settings is the usual path.
   - **Done when:** the error count is zero at the current strictness and one more flag is enabled.

6. Type the tricky shapes properly.
   - `TypedDict` for a dictionary with known keys, `Protocol` for structural typing instead of an abstract base class, `Literal` for a fixed set of strings, and `TypeVar` for a function whose return type depends on its input.
   - **Done when:** no function returns a bare `dict` where a `TypedDict` describes it.

## Verification

- The type checker reports zero errors at the configured strictness.
- CI runs the checker and fails on a new error.
- No new `Any` was introduced without a justification.
