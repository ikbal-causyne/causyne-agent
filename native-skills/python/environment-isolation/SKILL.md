---
name: environment-isolation
description: Install Python dependencies or run a Python script. Use before any pip install, when no virtual environment is active, or when a project has no dependency manifest.
---

# Python Environment Isolation

## The rule that has no exceptions

Never install into the system interpreter. On macOS and most Linux distributions the system Python is a dependency of the operating system, and a global install can break packaging tools, the desktop, or the boot path. Modern pip refuses by default (PEP 668) — that refusal is correct and must not be defeated with `--break-system-packages`.

## Workflow

1. Detect what is already there before creating anything.
   - Active environment: the `VIRTUAL_ENV` variable is set.
   - Project-local: a `.venv/` or `venv/` directory.
   - Managed: `poetry.lock`, `uv.lock`, `Pipfile.lock`, or `environment.yml` — each implies its own tool and its own commands.
   - **Done when:** you know which manager the project uses, or that it has none.

2. Use the project's manager if it has one.
   - `uv sync`, `poetry install`, `pipenv install`, `conda env create -f environment.yml`. Mixing plain pip into a managed project desynchronises the lock file.
   - **Done when:** dependencies are installed through the project's own tool.

3. Create an environment if none exists.
   - `python3 -m venv .venv` then activate. `uv venv` is faster where uv is available.
   - Add `.venv/` to `.gitignore`.
   - **Done when:** `VIRTUAL_ENV` is set and points into the project.

4. Chain activation into every command you run.
   - A tool invocation is a fresh shell, so activation does not persist between them. Every command must carry it: `source .venv/bin/activate && pytest`. On Windows: `.venv\Scripts\activate`.
   - **Done when:** every command that touches Python includes activation.

5. Record what you installed.
   - Add the dependency to `pyproject.toml` or `requirements.txt`. An install that is not recorded disappears on the next clean checkout.
   - **Done when:** a fresh clone plus an install reproduces the environment.

## Verification

- `which python` resolves inside the project directory.
- `python -c "import sys; print(sys.prefix)"` prints the environment path, not the system path.
- The new dependency appears in the manifest.
