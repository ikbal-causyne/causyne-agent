// Point every Causyne store at a throwaway root, BEFORE any of them load.
//
// Run via `node --test --import ./tests/helpers/isolateState.js`, so this
// executes before the first test file imports anything from src/. `causyneHome()`
// reads the environment once at module load, exactly like HOME itself, so the
// ordering is what makes the isolation total rather than partial.
//
// WHAT THIS STOPS. The suite used to write into the developer's real
// `~/.causyne`: 290 checkpoint tasks named "test-task" and 28 MB of workspace
// tree objects, sitting in the same undo history the user's own work lives in.
// A test run is not allowed to touch what it is testing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-test-home-'));
process.env.CAUSYNE_HOME = root;

// The neural engine's model files are large, slow to fetch, and READ-ONLY in
// use. Link rather than copy so Cortex tests still exercise real embeddings
// instead of silently skipping, while everything Cortex WRITES — the database —
// stays inside the throwaway root.
try {
  const realModels = path.join(os.homedir(), '.causyne', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(root, 'models'), 'dir');
} catch (e) { /* no models provisioned; Cortex tests skip, as they do on CI */ }

process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});
