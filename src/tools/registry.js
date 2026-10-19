import { sysRun, sysRunBg } from './sysRun.js';
import { fsRead } from './fsRead.js';
import { fsWrite } from './fsWrite.js';
import { fsEdit } from './fsEdit.js';
import { fsSearch } from './fsSearch.js';
import { fsFind } from './fsFind.js';
import { fsList } from './fsList.js';
import { fsMove } from './fsMove.js';
import { fsDelete } from './fsDelete.js';
import { gitExec } from './gitExec.js';
import { processList } from './processList.js';
import { procTerm } from './procTerm.js';
import { webFetch } from './webFetch.js';
import { desktopOpen } from './desktopOpen.js';
import { todoWrite } from './todoWrite.js';
import { multiEdit } from './multiEdit.js';
import { codebaseSearch } from './codebaseSearch.js';
import { browserAct } from './browserAutomator.js';
import { blenderAct } from './blenderAutomator.js';
import { resolveAutomator } from './resolveAutomator.js';
import { palmierAutomator } from './palmierAutomator.js';
import { viewImage } from './viewImage.js';
import { webSearch } from './webSearch.js';
import { updatePlan } from './updatePlan.js';
import { clipboard } from './clipboard.js';
import { screenshot } from './screenshot.js';
import { axSnapshot } from './axSnapshot.js';
import { desktopAct } from './desktopAct.js';
import { archive } from './archive.js';
import { checkSystemSpecs } from './checkSystemSpecs.js';
import { executeProceduralMedia } from './executeProceduralMedia.js';
import { manageLocalAiDependencies } from './manageLocalAiDependencies.js';
import { generateMediaViaApi } from './generateMediaViaApi.js';
import { memoryWrite } from './memoryWrite.js';
import { printerPrint, printerList, printerStatus } from './printer.js';
import { toolForgeTool } from './toolForge.js';
import { astryxOracle } from './astryxOracle.js';
import { pdfRead } from './pdfReader.js';
import { codeVerifySyntax, codeListSymbols } from './codeTools.js';
import { codeSearcher } from './codeSearcher.js';
import { codeSearchAst } from './codeSearchAst.js';
import { persistentShell } from './persistentShell.js';
import { subagentOrchestrator } from './subagentOrchestrator.js';
import { deferredMcpSearch } from './deferredMcpSearch.js';
import { visionInspector } from './visionInspector.js';
import { godotAutomator } from './godotAutomator.js';
import { gameBuilder } from './gameBuilder.js';
import { gameAssetFetcher } from './gameAssetFetcher.js';
import { gameLoreForge } from './gameLoreForge.js';
import { gameDialogueTreeGen } from './gameDialogueTreeGen.js';
import { gameQuestArcBuilder } from './gameQuestArcBuilder.js';
import { gameAnimationRig } from './gameAnimationRig.js';
import { gameAiBehaviorTree } from './gameAiBehaviorTree.js';
import { gameCinematicSequencer } from './gameCinematicSequencer.js';
import { gameAssetHarvester } from './gameAssetHarvester.js';
import { gameAudioSynth } from './gameAudioSynth.js';
import { gameVfxEmitterGen } from './gameVfxEmitterGen.js';
import { gameShaderForge } from './gameShaderForge.js';
import { gameSceneBuilder } from './gameSceneBuilder.js';
import { gameEntitySpawner } from './gameEntitySpawner.js';
import { gameTilemapGenerator } from './gameTilemapGenerator.js';
import { gameUiHudBuilder } from './gameUiHudBuilder.js';
import { gameEconomyBalancer } from './gameEconomyBalancer.js';
import { gameDataForge } from './gameDataForge.js';
import { gameWebRuntimeInspector } from './gameWebRuntimeInspector.js';
import { gameCanvasAudit } from './gameCanvasAudit.js';
import readNativeSkill from './readNativeSkill.js';
import { createSkill } from './createSkill.js';
import { resolveActiveTools } from '../toolPacks.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverTools, resolveMcpTool, isMcpToolName } from '../mcp/mcpRegistry.js';
import { causyneHome } from '../utils/paths.js';

// Phase 6 AGI Upgrade: Schema Validation Hook
function validateSchema(schema) {
  if (!schema || !schema.name || !schema.description) {
    console.error(`[REGISTRY WARNING] Tool schema missing required name or description:`, schema);
    return false;
  }
  return true;
}

/**
 * The one place a tool name is canonicalised. Schemas are authored with dots
 * (`fs.read`) because that reads well; every provider's function-name grammar
 * only allows [a-zA-Z0-9_-], so the wire name is always the underscored form.
 *
 * Every lookup — the agent loop, the sandbox, the pack resolver — must go
 * through this, or the two namespaces drift apart again.
 */
// MCP is imported lazily-safe: this module is on the hot path of every LLM
// call, and mcpRegistry only touches config until a server is actually granted.
export function normalizeToolName(name) {
  return String(name || '').replace(/\./g, '_');
}

// SINGLE SOURCE OF TRUTH.
//
// TOOL_DEFINITIONS (what the model is told exists) and toolRegistry (what can
// actually run) are both derived from this one list, so a tool can never be
// advertised without being executable. The previous design kept a separate
// hand-written registry map, and four tools had silently drifted out of it:
// fs_find (a CORE tool, in context on every task), proc_term, palmier_act and
// code_search_ast. Every model on every provider got "Tool does not exist".
const TOOL_MODULES = [
  sysRun, sysRunBg, fsRead, fsWrite,
  fsEdit, fsFind, fsSearch, fsList, fsMove,
  fsDelete, gitExec, processList, procTerm,
  webFetch, desktopOpen, todoWrite, multiEdit,
  codebaseSearch, browserAct, viewImage, webSearch,
  updatePlan, clipboard, screenshot, axSnapshot, desktopAct, archive,
  checkSystemSpecs, executeProceduralMedia, manageLocalAiDependencies,
  generateMediaViaApi, memoryWrite, printerPrint, printerList, printerStatus, toolForgeTool,
  astryxOracle, pdfRead, codeVerifySyntax, codeListSymbols, blenderAct, resolveAutomator, palmierAutomator,
  codeSearchAst, codeSearcher, persistentShell, subagentOrchestrator, deferredMcpSearch, visionInspector,
  godotAutomator, gameBuilder, gameAssetFetcher,
  gameLoreForge, gameDialogueTreeGen, gameQuestArcBuilder,
  gameAnimationRig, gameAiBehaviorTree, gameCinematicSequencer,
  gameAssetHarvester, gameAudioSynth, gameVfxEmitterGen,
  gameShaderForge, gameSceneBuilder, gameEntitySpawner,
  gameTilemapGenerator, gameUiHudBuilder, gameEconomyBalancer,
  gameDataForge, gameWebRuntimeInspector, gameCanvasAudit, readNativeSkill, createSkill
];

// Base static definitions (backwards compatible). Order is preserved from the
// list above because every provider's prompt cache binds on the tool array, and
// reshuffling it invalidates the cached prefix mid-task.
export const TOOL_DEFINITIONS = [];
export const toolRegistry = {};

for (const module of TOOL_MODULES) {
  if (!module || !validateSchema(module.schema)) continue;

  const name = normalizeToolName(module.schema.name);
  if (typeof module.execute !== 'function') {
    console.error(`[REGISTRY WARNING] Tool "${name}" has no execute() and cannot run — skipping.`);
    continue;
  }

  TOOL_DEFINITIONS.push({ ...module.schema, name });
  toolRegistry[name] = module;
}

// Names that older releases (and any chat history persisted under them) used for
// a tool whose canonical schema name is different. Resolved only at execution
// time — never advertised, so they cost no context.
const TOOL_ALIASES = {
  manage_local_ai_dependencies: 'manage_local_dependencies',
  procTerm: 'proc_term',
  gitExec: 'gitOp',
  // Renamed once a real MCP client existed: this tool searches Causyne's own
  // registry and never spoke the protocol its old name advertised. The alias
  // stays so a model that learned the old name still resolves.
  tool_deferred_mcp_search: 'tool_search'
};

/** Resolve a name the model produced to a runnable tool, following aliases. */
export function resolveTool(name) {
  const normalized = normalizeToolName(name);
  const native = toolRegistry[normalized] || toolRegistry[TOOL_ALIASES[normalized]] || null;
  if (native) return native;
  // MCP tools are namespaced `mcp__server__tool`, so they can never shadow a
  // native name — the native lookup always wins above.
  if (isMcpToolName(name)) return resolveMcpTool(name);
  return null;
}

/** The canonical catalogue name for anything the model might call it. */
export function canonicalToolName(name) {
  const normalized = normalizeToolName(name);
  if (toolRegistry[normalized]) return normalized;
  return TOOL_ALIASES[normalized] || normalized;
}

// Forged tools are hot-reloadable, but re-importing them with a cache-busting
// query string on every single agent step leaked one ES module per step and
// changed the tool ordering between requests, which silently defeats OpenAI and
// DeepSeek automatic prompt caching. We reload only when a file actually
// changes, keyed on path + mtime.
const forgedModuleCache = new Map();

async function loadForgedTools() {
  const CUSTOM_TOOLS_DIR = path.join(causyneHome(), 'custom_tools');
  if (!fs.existsSync(CUSTOM_TOOLS_DIR)) return [];

  const forged = [];
  // Sorted so the resulting schema order is identical across requests.
  const files = fs.readdirSync(CUSTOM_TOOLS_DIR).filter(f => f.endsWith('.js')).sort();

  for (const file of files) {
    const fullPath = path.join(CUSTOM_TOOLS_DIR, file);
    try {
      const mtime = fs.statSync(fullPath).mtimeMs;
      const cached = forgedModuleCache.get(fullPath);
      let imported;

      if (cached && cached.mtime === mtime) {
        imported = cached.module;
      } else {
        imported = await import(`file://${fullPath}?v=${mtime}`);
        forgedModuleCache.set(fullPath, { mtime, module: imported });
      }

      for (const key of Object.keys(imported)) {
        if (imported[key] && imported[key].schema) {
          const normalizedName = imported[key].schema.name.replace(/\./g, '_');
          forged.push({ ...imported[key].schema, name: normalizedName });
          if (!toolRegistry[normalizedName]) {
            toolRegistry[normalizedName] = imported[key];
          }
        }
      }
    } catch (e) {
      console.error(`[TOOL FORGE] Failed to load custom tool ${file}:`, e.message);
    }
  }

  return forged;
}

// Phase 6 AGI Upgrade & V5 Cortex: Dynamic Tool Culling and Hot-Reloading Engine
//
// options.unlockedPacks / options.unlockedTools drive Sovereign Progressive
// Disclosure (see src/toolPacks.js). No tool is ever removed from the catalogue
// — deferred schemas simply stay out of the context window until the agent
// pre-warms or searches for them. options.grantAllTools restores the legacy
// behaviour of loading all 69 schemas up front.
export async function getDynamicTools(autonomyMode = 'C', supportsVision = true, options = {}) {
  const forged = await loadForgedTools();
  // Tools from user-configured MCP servers, appended last so the native
  // schema order — which the provider prompt caches depend on — never shifts.
  let mcp = [];
  try {
    mcp = await discoverTools();
  } catch (e) { /* a broken third-party server must not take the catalogue down */ }
  let tools = [...TOOL_DEFINITIONS, ...forged, ...mcp];

  if (!options.grantAllTools) {
    tools = resolveActiveTools(tools, options.unlockedPacks, options.unlockedTools, options.unlockOrder, {
      residentOnly: options.residentOnly === true
    });
  }

  // Vision Toggle Culling
  if (!supportsVision) {
    // Phase 6 Fix: Do not hide view_image. Allow it to serve as a Text-Only OCR Fallback for blind LLMs.
    tools = tools.filter(t => t.name !== 'screenshot' && t.name !== 'vision_inspect_ui');
  }

  // Capability Culling (finding D-6).
  //
  // A tool the user has explicitly DECLINED can never run, so showing its
  // schema only invites the model to spend a step discovering that. A tool that
  // is merely un-granted stays visible: calling it is how the model learns to
  // ask for the capability, which is the intended flow.
  try {
    const { declinedToolNames } = await import('../provisioning/capabilityTools.js');
    const declined = declinedToolNames();
    if (declined.size > 0) tools = tools.filter(t => !declined.has(t.name));
  } catch (e) { /* provisioning unavailable: show everything rather than hide capability */ }

  // Autonomy Mode Culling (Save tokens and prevent hallucinations on Mode A).
  // Names here are canonical catalogue names — the legacy dotted/camelCase
  // variants that used to pad these sets never matched a schema name and so
  // culled nothing.
  if (autonomyMode === 'A') {
    const dangerousTools = new Set(['proc_term', 'gitOp', 'fs_delete', 'sysRun', 'sysRunBg', 'terminal_persistent_shell', 'manage_local_dependencies']);
    tools = tools.filter(t => !dangerousTools.has(t.name));
  } else if (autonomyMode === 'B') {
    const dangerousTools = new Set(['proc_term', 'manage_local_dependencies']);
    tools = tools.filter(t => !dangerousTools.has(t.name));
  }

  return tools;
}
