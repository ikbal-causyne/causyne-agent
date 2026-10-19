---
name: packaging-and-distribution
description: Package a Python project for distribution or make it installable. Use when a project has setup.py only, when imports fail after install, or before publishing to an index.
---

# Packaging and Distribution

## The current shape

`pyproject.toml` with a PEP 621 `[project]` table. `setup.py` is legacy; `setup.cfg` is superseded. A new project should have neither.

## Workflow

1. Choose the layout.
   - `src/` layout: the package lives in `src/mypkg/`. This is the correct default, because it makes it impossible to import the package from the working directory — so the tests exercise the INSTALLED package, which is what users get.
   - Flat layout imports from the source tree and hides packaging bugs until release.
   - **Done when:** the package is under `src/` and the tests still pass.

2. Declare the metadata once.
   - Name, version, description, requires-python, dependencies, and the entry points. Read the version from a single source — either the package or the manifest — never both.
   - **Done when:** `python -m build` produces a wheel and a source distribution without warnings.

3. Pin ranges, not exact versions, for a library.
   - A library that pins exact versions makes itself uninstallable alongside anything else. An application may pin exactly, and should, via a lock file.
   - **Done when:** the dependency specifiers match the kind of project.

4. Test the built artefact, not the source tree.
   - Install the wheel into a clean environment and import it. A package that works in-tree and fails on install has a missing `package-data` entry or a wrong layout, and only this step catches it.
   - **Done when:** the wheel installs and imports in a fresh environment.

5. Check what is inside the artefact.
   - `python -m zipfile -l dist/*.whl`. Look for missing data files and for accidentally included test or secret files.
   - **Done when:** the wheel contains exactly what should ship.

## Template

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "mypkg"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27,<1.0"]

[project.scripts]
mypkg = "mypkg.cli:main"
```

## Verification

- `python -m build` succeeds with no warnings.
- The wheel installs into a clean environment and the entry point runs.
- The archive listing contains no test files and no credentials.
