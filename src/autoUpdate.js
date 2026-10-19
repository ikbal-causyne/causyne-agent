import { UI } from './utils/cli_ui.js';

// No registry polling or self-modifying installation. A release channel has
// not been selected or published for the independent Causyne project yet.
export async function runSelfUpdate(verbose = false) {
  if (verbose) UI.printInfo('Automatic updates are disabled. Review and update your Causyne source checkout explicitly. No public package is configured yet.');
  return false;
}

export function startUpdateChecker() {
  // Compatibility with the local CLI caller; deliberately no timer or I/O.
}
