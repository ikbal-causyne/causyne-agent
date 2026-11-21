/**
 * Legacy host-process dynamic tool loader is retired.
 * Unverified JavaScript files are never imported directly into the host process;
 * custom tools must be packaged as digest-verified plugins via plugin_manager.
 */
export async function loadDynamicTools() {
    return Object.create(null);
}
