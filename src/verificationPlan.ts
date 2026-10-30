/**
 * @file src/verificationPlan.ts
 * Verification stage of the pipeline.
 *
 *   ... AgentLoop -> near completion -> verify -> Observer -> TimeMachine
 *
 * Work is not finished when the model says so; it is finished when evidence of
 * the right KIND exists. What counts depends on what was produced: code is run
 * or checked, a page is rendered and looked at, a render or image is viewed, a
 * document is read back. File moves, deletes and the like are not here on
 * purpose: the tool's own success result is already their evidence.
 *
 * Everything here reads the observer's journal — what actually ran — and never
 * the model's account of it.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import type { ToolOutcome } from './observer/evidence.js';
import { isVerificationCommand } from './observer/evidence.js';

export type VerificationDomain = 'code' | 'web' | 'creative' | 'document';

export interface VerificationGap {
  readonly domain: VerificationDomain;
  /** What evidence is missing, in words a model can act on. */
  readonly need: string;
  /** Listed tools that can produce it; fed back through decideTools. */
  readonly tools: readonly string[];
}

export interface VerificationAssessment {
  readonly domains: readonly VerificationDomain[];
  readonly gaps: readonly VerificationGap[];
  /** Empty when nothing is missing. */
  readonly directive: string;
}

export interface VerificationInput {
  readonly archetype?: string | undefined;
  readonly outcomes: readonly ToolOutcome[];
  /** Domains another gate already enforces, so they are not nagged twice. */
  readonly skip?: readonly VerificationDomain[];
}

const CODE_MUTATORS = new Set([
  'fs_write', 'fs_edit', 'MultiEdit', 'write_file', 'write_to_file', 'edit_file',
  'replace_file_content', 'multi_replace_file_content', 'write', 'edit', 'multiedit'
]);
const CREATIVE_MUTATORS = new Set([
  'blender_act', 'creative_apps', 'execute_procedural_media', 'generate_media_via_api',
  'native_engine', 'resolve_act', 'palmier_act', 'game_audio_synth'
]);

const WEB_PATH = /\.(?:html?|css|scss|jsx|tsx|vue|svelte)$/i;
const CODE_PATH = /\.(?:[cm]?[jt]s|py|rb|php|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|sh|sql)$/i;
const DOCUMENT_PATH = /\.(?:pdf|docx?|pptx?|odt|rtf|epub)$/i;
const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|bmp)$/i;

const RUN_COMMAND = /^\s*(?:node|python3?|ruby|php|deno|bun|go\s+run|cargo\s+run|dotnet\s+run|swift\s+run|java|npm\s+(?:start|run\s+(?:dev|start)))\b/i;
const MEDIA_PROBE = /\b(?:ffprobe|afinfo|soxi|identify|mediainfo|exiftool)\b/i;

const READBACK_TOOLS = new Set(['pdf_read', 'fs_read', 'view_image', 'vision_inspect_ui', 'screenshot']);
const LOOK_TOOLS = new Set(['view_image', 'vision_inspect_ui', 'screenshot']);

function isMutation(outcome: ToolOutcome): boolean {
  if (!outcome.success) return false;
  const tool = outcome.tool;
  if (CODE_MUTATORS.has(tool) || CREATIVE_MUTATORS.has(tool)) return true;
  if (tool === 'document_forge') return true;
  return false;
}

function domainsOf(input: VerificationInput, mutations: readonly ToolOutcome[]): VerificationDomain[] {
  const found = new Set<VerificationDomain>();
  for (const outcome of mutations) {
    const tool = outcome.tool;
    const target = outcome.path || '';
    if (CREATIVE_MUTATORS.has(tool)) found.add('creative');
    else if (tool === 'document_forge' || DOCUMENT_PATH.test(target)) found.add('document');
    else if (CODE_MUTATORS.has(tool)) {
      if (WEB_PATH.test(target)) found.add('web');
      else if (CODE_PATH.test(target)) found.add('code');
    }
  }
  if (input.archetype === 'web_engineering' && found.has('code')) found.add('web');
  return [...found];
}

function after(outcomes: readonly ToolOutcome[], domain: VerificationDomain): readonly ToolOutcome[] {
  const matches = (outcome: ToolOutcome): boolean => {
    if (!isMutation(outcome)) return false;
    const target = outcome.path || '';
    switch (domain) {
      case 'creative': return CREATIVE_MUTATORS.has(outcome.tool);
      case 'document': return outcome.tool === 'document_forge' || DOCUMENT_PATH.test(target);
      case 'web': return CODE_MUTATORS.has(outcome.tool) && WEB_PATH.test(target);
      case 'code': return CODE_MUTATORS.has(outcome.tool) && CODE_PATH.test(target);
    }
  };
  return outcomes.slice(outcomes.findLastIndex(matches) + 1);
}

function satisfied(domain: VerificationDomain, evidence: readonly ToolOutcome[]): boolean {
  const ok = evidence.filter((outcome) => outcome.success);
  switch (domain) {
    case 'code':
      return ok.some((outcome) => outcome.tool === 'code_verify_syntax'
        || isVerificationCommand(outcome.command)
        || (RUN_COMMAND.test(outcome.command) && outcome.exitCode === 0));
    case 'web':
      return ok.some((outcome) => outcome.rendered === true);
    case 'creative':
      return ok.some((outcome) => outcome.observedImage === true
        || MEDIA_PROBE.test(outcome.command));
    case 'document':
      return ok.some((outcome) => outcome.observedImage === true
        || (['pdf_read', 'fs_read'].includes(outcome.tool) && DOCUMENT_PATH.test(outcome.path)));
  }
}

const NEEDS: Readonly<Record<VerificationDomain, { need: string; tools: readonly string[] }>> = {
  code: {
    need: 'run the code or its tests, build, or a syntax check (sysRun, code_verify_syntax)',
    tools: ['sysRun', 'code_verify_syntax']
  },
  web: {
    need: 'render the page (browser_act preview, then snapshot) and look at it (screenshot or vision_inspect_ui)',
    tools: ['browser_act', 'screenshot']
  },
  creative: {
    need: 'look at the produced image, render or frame (view_image or vision_inspect_ui) and probe audio or video output',
    tools: ['view_image', 'vision_inspect_ui']
  },
  document: {
    need: 'read the produced document back (pdf_read, fs_read or view_image) and confirm it matches the request',
    tools: ['pdf_read', 'view_image']
  }
};

/**
 * What evidence is still missing for what this task actually produced. Nothing
 * produced means nothing to verify: research and conversation are never nagged.
 */
export function assessVerification(input: VerificationInput): VerificationAssessment {
  const mutations = input.outcomes.filter(isMutation);
  if (mutations.length === 0) return { domains: [], gaps: [], directive: '' };

  const skip = new Set(input.skip ?? []);
  const domains = domainsOf(input, mutations);
  const gaps: VerificationGap[] = [];
  for (const domain of domains) {
    if (skip.has(domain)) continue;
    if (satisfied(domain, after(input.outcomes, domain))) continue;
    gaps.push({ domain, ...NEEDS[domain] });
  }
  if (gaps.length === 0) return { domains, gaps, directive: '' };

  const needs = gaps.map((gap) => `${gap.domain}: ${gap.need}`).join('; ');
  return {
    domains,
    gaps,
    directive: `[VERIFY] You changed things but no evidence of the right kind exists yet. Before you finish — ${needs}. `
      + 'If a check cannot be run, say so plainly instead of claiming success.'
  };
}
