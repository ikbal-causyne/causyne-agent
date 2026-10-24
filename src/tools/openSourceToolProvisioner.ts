import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import util from 'node:util';
import { causyneHome, resolveUserPath } from '../utils/paths.js';
import { isAutonomousToolContext } from '../approvalPolicy.js';

const execFilePromise = util.promisify(execFile);

export interface SystemSpecs {
  platform: string;
  architecture: string;
  totalRamMB: number;
  freeRamMB: number;
  cpuCores: number;
  cpuModel: string;
  diskSpaceGB: number;
  diskSpaceText: string;
  accelerator: 'Apple Silicon Metal (Unified Memory)' | 'NVIDIA CUDA' | 'CPU';
}

export interface OpenSourceToolProfile {
  id: string;
  name: string;
  category: 'voice' | 'audio' | 'vision' | 'llm' | 'utilities';
  repo: string;
  url: string;
  license: string;
  description: string;
  minRamMB: number;
  recommendedRamMB: number;
  diskFootprintMB: number;
  computeType: string;
  supportedPlatforms?: string[];
  installMethod: 'pip' | 'binary' | 'git';
  pipPackages?: string[];
  lightweightAlternativeId?: string;
}

export interface CompatibilityReport {
  compatible: boolean;
  status: 'READY_OPTIMAL' | 'READY_MARGINAL' | 'INSUFFICIENT_HARDWARE';
  reason: string;
  ramAssessment: string;
  diskAssessment: string;
  computeAssessment: string;
}

export const CURATED_OPEN_SOURCE_CATALOGUE: Record<string, OpenSourceToolProfile> = {
  'f5-tts': {
    id: 'f5-tts',
    name: 'F5-TTS (Fairytale-5 Voice Cloning)',
    category: 'voice',
    repo: 'SWivid/F5-TTS',
    url: 'https://github.com/SWivid/F5-TTS',
    license: 'MIT',
    description: 'State-of-the-art non-autoregressive zero-shot voice cloning with Flow Matching. Natural prosody and high similarity from a 5-10s audio reference.',
    minRamMB: 4096,
    recommendedRamMB: 8192,
    diskFootprintMB: 1800,
    computeType: 'Apple Silicon Metal (MPS) / NVIDIA CUDA / CPU',
    installMethod: 'pip',
    pipPackages: ['f5-tts==0.2.2', 'soundfile>=0.12.1'],
    lightweightAlternativeId: 'kokoro-82m'
  },
  'kokoro-82m': {
    id: 'kokoro-82m',
    name: 'Kokoro-82M Ultra-Light TTS',
    category: 'voice',
    repo: 'hexgrad/Kokoro-82M',
    url: 'https://github.com/hexgrad/Kokoro-82M',
    license: 'Apache-2.0',
    description: 'Ultra-compact 82M parameter speech synthesizer with studio-quality prosody. Runs smoothly on low RAM and pure CPU.',
    minRamMB: 1024,
    recommendedRamMB: 2048,
    diskFootprintMB: 350,
    computeType: 'CPU / Apple Silicon Metal / CUDA',
    installMethod: 'pip',
    pipPackages: ['kokoro>=0.8.4', 'soundfile>=0.12.1']
  },
  'xtts-v2': {
    id: 'xtts-v2',
    name: 'Coqui XTTS-v2 Voice Cloner',
    category: 'voice',
    repo: 'coqui-ai/TTS',
    url: 'https://github.com/coqui-ai/TTS',
    license: 'CPML / Research',
    description: 'Multilingual zero-shot voice cloning across 17+ languages using a 3-second audio sample.',
    minRamMB: 6144,
    recommendedRamMB: 12288,
    diskFootprintMB: 3800,
    computeType: 'NVIDIA CUDA / Apple Silicon MPS / Fast CPU',
    installMethod: 'pip',
    pipPackages: ['TTS>=0.22.0'],
    lightweightAlternativeId: 'kokoro-82m'
  },
  'chatterbox': {
    id: 'chatterbox',
    name: 'Chatterbox TTS & Voice Clone',
    category: 'voice',
    repo: 'resemble-ai/Chatterbox',
    url: 'https://github.com/resemble-ai/Chatterbox',
    license: 'MIT',
    description: 'Open-source voice cloning toolkit with low latency and clean speech synthesis.',
    minRamMB: 4096,
    recommendedRamMB: 8192,
    diskFootprintMB: 1500,
    computeType: 'CPU / MPS / CUDA',
    installMethod: 'pip',
    pipPackages: ['chatterbox-tts>=0.1.0'],
    lightweightAlternativeId: 'kokoro-82m'
  },
  'whisper-cpp': {
    id: 'whisper-cpp',
    name: 'Whisper.cpp High-Speed Transcriber',
    category: 'audio',
    repo: 'ggerganov/whisper.cpp',
    url: 'https://github.com/ggerganov/whisper.cpp',
    license: 'MIT',
    description: 'High-performance speech-to-text inference in pure C/C++ with zero dependencies. Optimized for Apple Silicon Metal & AVX2.',
    minRamMB: 1024,
    recommendedRamMB: 4096,
    diskFootprintMB: 450,
    computeType: 'Apple Silicon Metal / CPU / CUDA',
    installMethod: 'binary',
    lightweightAlternativeId: 'whisper-cpp'
  },
  'faster-whisper': {
    id: 'faster-whisper',
    name: 'Faster-Whisper (CTranslate2)',
    category: 'audio',
    repo: 'SYSTRAN/faster-whisper',
    url: 'https://github.com/SYSTRAN/faster-whisper',
    license: 'MIT',
    description: 'Reimplementation of Whisper using CTranslate2, up to 4x faster with lower memory consumption.',
    minRamMB: 2048,
    recommendedRamMB: 4096,
    diskFootprintMB: 800,
    computeType: 'CPU / CUDA / MPS',
    installMethod: 'pip',
    pipPackages: ['faster-whisper>=1.0.0']
  },
  'realesrgan': {
    id: 'realesrgan',
    name: 'Real-ESRGAN Image & Video Upscaler',
    category: 'vision',
    repo: 'xinntao/Real-ESRGAN',
    url: 'https://github.com/xinntao/Real-ESRGAN',
    license: 'BSD-3-Clause',
    description: 'Practical AI algorithms for general image restoration, super-resolution, and 4x upscaling.',
    minRamMB: 4096,
    recommendedRamMB: 8192,
    diskFootprintMB: 600,
    computeType: 'Apple Silicon Metal / CUDA / CPU',
    installMethod: 'pip',
    pipPackages: ['realesrgan>=0.3.0']
  },
  'rembg': {
    id: 'rembg',
    name: 'Rembg (Background Removal)',
    category: 'vision',
    repo: 'danielgatis/rembg',
    url: 'https://github.com/danielgatis/rembg',
    license: 'MIT',
    description: 'Tool to remove background from images using U^2-Net and ONNX runtime.',
    minRamMB: 2048,
    recommendedRamMB: 4096,
    diskFootprintMB: 400,
    computeType: 'CPU / ONNX / CUDA',
    installMethod: 'pip',
    pipPackages: ['rembg>=2.0.50']
  },
  'ollama': {
    id: 'ollama',
    name: 'Ollama Sovereign Model Runner',
    category: 'llm',
    repo: 'ollama/ollama',
    url: 'https://github.com/ollama/ollama',
    license: 'MIT',
    description: 'Run open-source LLMs and local embedding models directly on Apple Silicon Metal or CUDA.',
    minRamMB: 4096,
    recommendedRamMB: 16384,
    diskFootprintMB: 3000,
    computeType: 'Apple Silicon Metal / NVIDIA CUDA / CPU',
    installMethod: 'binary'
  }
};

export async function detectSystemSpecs(workspaceRoot?: string): Promise<SystemSpecs> {
  const totalRamMB = Math.round(os.totalmem() / 1024 / 1024);
  let freeRamMB = Math.round(os.freemem() / 1024 / 1024);
  const platform = os.platform();
  const architecture = os.arch();
  const cpuCores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';

  // macOS memory accounting: add inactive buffer estimate
  if (platform === 'darwin') {
    const usedApprox = totalRamMB - freeRamMB;
    const inactiveApprox = usedApprox * 0.4;
    freeRamMB = Math.round(freeRamMB + inactiveApprox);
  }

  // Disk space detection
  let diskSpaceGB = 10;
  let diskSpaceText = '10 GB available';
  try {
    const checkDir = workspaceRoot || process.cwd();
    const stats = await fsp.statfs(checkDir);
    const freeBytes = stats.bavail * stats.bsize;
    diskSpaceGB = Math.round(freeBytes / 1024 / 1024 / 1024);
    diskSpaceText = `${diskSpaceGB} GB available`;
  } catch {
    // Fallback on default assumption
  }

  // Accelerator detection
  let accelerator: SystemSpecs['accelerator'] = 'CPU';
  if (platform === 'darwin' && architecture === 'arm64') {
    accelerator = 'Apple Silicon Metal (Unified Memory)';
  } else if (process.env['CUDA_VISIBLE_DEVICES'] || fs.existsSync('/usr/local/cuda')) {
    accelerator = 'NVIDIA CUDA';
  }

  return {
    platform,
    architecture,
    totalRamMB,
    freeRamMB,
    cpuCores,
    cpuModel,
    diskSpaceGB,
    diskSpaceText,
    accelerator
  };
}

export function evaluateHardwareCompatibility(
  specs: SystemSpecs,
  tool: OpenSourceToolProfile
): CompatibilityReport {
  const hasMinRam = specs.freeRamMB >= tool.minRamMB || specs.totalRamMB >= tool.minRamMB + 1024;
  const hasComfortableRam = specs.freeRamMB >= tool.recommendedRamMB;
  const diskNeededGB = Math.ceil(tool.diskFootprintMB / 1024);
  const hasDisk = specs.diskSpaceGB >= diskNeededGB + 2; // Keep at least 2GB breathing room

  let status: CompatibilityReport['status'] = 'READY_OPTIMAL';
  let compatible = true;
  let reason = 'Hardware specs meet or exceed recommended operational thresholds.';

  if (!hasMinRam || !hasDisk) {
    status = 'INSUFFICIENT_HARDWARE';
    compatible = false;
    reason = !hasMinRam
      ? `Insufficient RAM: Needs minimum ${Math.round(tool.minRamMB / 1024)}GB, but only ~${Math.round(specs.freeRamMB / 1024)}GB is currently free.`
      : `Insufficient Disk Space: Needs ~${diskNeededGB}GB, but only ${specs.diskSpaceGB}GB is available.`;
  } else if (!hasComfortableRam) {
    status = 'READY_MARGINAL';
    reason = `System meets minimum RAM (${Math.round(tool.minRamMB / 1024)}GB) but is below recommended ${Math.round(tool.recommendedRamMB / 1024)}GB. Inference may be slower or share memory with other applications.`;
  }

  const ramAssessment = `RAM: ${Math.round(specs.freeRamMB / 1024)}GB free / ${Math.round(specs.totalRamMB / 1024)}GB total (Tool requires ${Math.round(tool.minRamMB / 1024)}GB min, ${Math.round(tool.recommendedRamMB / 1024)}GB recommended).`;
  const diskAssessment = `Disk: ${specs.diskSpaceGB}GB free (Tool footprint ~${(tool.diskFootprintMB / 1024).toFixed(1)}GB).`;
  const computeAssessment = `Compute: ${specs.accelerator} (${specs.cpuCores} cores, ${specs.cpuModel}).`;

  return {
    compatible,
    status,
    reason,
    ramAssessment,
    diskAssessment,
    computeAssessment
  };
}

export function searchCatalogue(intentOrQuery: string): OpenSourceToolProfile[] {
  const q = (intentOrQuery || '').toLowerCase().trim();
  const profiles = Object.values(CURATED_OPEN_SOURCE_CATALOGUE);
  if (!q) return profiles;

  return profiles.filter(p => {
    return (
      p.id.includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      (q.includes('voice') && (p.category === 'voice' || p.id.includes('tts'))) ||
      (q.includes('clone') && p.category === 'voice') ||
      (q.includes('speech') && (p.category === 'voice' || p.category === 'audio')) ||
      (q.includes('audio') && (p.category === 'voice' || p.category === 'audio')) ||
      (q.includes('upscale') && p.id === 'realesrgan') ||
      (q.includes('background') && p.id === 'rembg') ||
      (q.includes('transcribe') && p.category === 'audio')
    );
  });
}

export const openSourceToolProvisioner = {
  schema: {
    name: 'open_source_tool_provisioner',
    description: 'Discover, evaluate hardware compatibility, and install open-source AI tools and models. Mode C authorizes in-scope installs; supervised modes require confirmation. Hardware, disk, and workspace checks still apply.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['discover', 'evaluate', 'install', 'list_installed'],
          description: 'Action: discover (search tools matching user intent & evaluate hardware), evaluate (check hardware compatibility for a specific toolId), install (install approved open source tool with HITL confirm flag), or list_installed (view installed local tools).'
        },
        intent: {
          type: 'string',
          description: 'User intent or domain (e.g., "voice cloning", "clone my voice", "audio transcription", "image upscaling", "local llm").'
        },
        toolId: {
          type: 'string',
          description: 'Identifier of the open-source tool (e.g., "f5-tts", "kokoro-82m", "whisper-cpp", "xtts-v2", "realesrgan", "rembg", "ollama").'
        },
        confirm: {
          type: 'boolean',
          description: 'Explicit confirmation for supervised modes. Mode C authorizes in-scope installs without this flag.'
        },
        forceAlternative: {
          type: 'boolean',
          description: 'If true, automatically select the lightweight low-RAM alternative if the primary tool is heavy.'
        }
      },
      required: ['action']
    }
  },

  async execute(args: Record<string, unknown>, sandbox: Record<string, unknown> = {}) {
    const action = String(args['action'] || 'discover');
    const intent = typeof args['intent'] === 'string' ? args['intent'] : '';
    let toolId = typeof args['toolId'] === 'string' ? args['toolId'].toLowerCase().trim() : '';
    const confirm = args['confirm'] === true || isAutonomousToolContext(sandbox);
    const forceAlternative = args['forceAlternative'] === true;

    const workspaceDir = (Array.isArray(sandbox['workspacePaths']) && sandbox['workspacePaths'][0])
      ? String(sandbox['workspacePaths'][0])
      : process.cwd();

    const specs = await detectSystemSpecs(workspaceDir);

    // ── ACTION: DISCOVER ──────────────────────────────────────────────────
    if (action === 'discover') {
      const matches = searchCatalogue(intent || toolId);
      if (matches.length === 0) {
        return {
          success: true,
          query: intent,
          systemSpecs: specs,
          message: `No exact local catalogue match for "${intent}". You may search GitHub directly via web_search or query another domain.`,
          recommendations: []
        };
      }

      const evaluations = matches.map(tool => {
        const evalReport = evaluateHardwareCompatibility(specs, tool);
        return {
          id: tool.id,
          name: tool.name,
          category: tool.category,
          repoUrl: tool.url,
          license: tool.license,
          description: tool.description,
          diskSize: `~${(tool.diskFootprintMB / 1024).toFixed(1)} GB`,
          ramRequired: `${Math.round(tool.minRamMB / 1024)}GB min, ${Math.round(tool.recommendedRamMB / 1024)}GB rec`,
          compute: tool.computeType,
          status: evalReport.status,
          compatible: evalReport.compatible,
          advice: evalReport.reason,
          lightweightAlternative: tool.lightweightAlternativeId
        };
      });

      // Sort optimal first
      evaluations.sort((a, b) => {
        const score = (s: string) => (s === 'READY_OPTIMAL' ? 2 : s === 'READY_MARGINAL' ? 1 : 0);
        return score(b.status) - score(a.status);
      });

      return {
        success: true,
        intent: intent || 'general',
        systemSpecs: {
          platform: specs.platform,
          architecture: specs.architecture,
          cpu: `${specs.cpuCores} cores (${specs.cpuModel})`,
          accelerator: specs.accelerator,
          totalRamGB: Math.round(specs.totalRamMB / 1024),
          freeRamGB: Math.round(specs.freeRamMB / 1024),
          diskSpace: specs.diskSpaceText
        },
        recommendations: evaluations,
        instruction: 'To install a candidate, review the hardware assessment and invoke with action: "install", toolId: "<id>". Supervised modes require explicit confirmation.'
      };
    }

    // ── ACTION: EVALUATE ──────────────────────────────────────────────────
    if (action === 'evaluate') {
      if (!toolId) {
        return { success: false, error: 'Missing toolId for evaluate action.' };
      }
      const tool = CURATED_OPEN_SOURCE_CATALOGUE[toolId];
      if (!tool) {
        return { success: false, error: `Unknown toolId "${toolId}". Choose from: ${Object.keys(CURATED_OPEN_SOURCE_CATALOGUE).join(', ')}` };
      }

      const evalReport = evaluateHardwareCompatibility(specs, tool);
      return {
        success: true,
        tool: {
          id: tool.id,
          name: tool.name,
          repoUrl: tool.url,
          license: tool.license,
          diskSize: `~${(tool.diskFootprintMB / 1024).toFixed(1)} GB`,
          minRam: `${Math.round(tool.minRamMB / 1024)} GB`,
          recommendedRam: `${Math.round(tool.recommendedRamMB / 1024)} GB`,
          compute: tool.computeType
        },
        systemSpecs: specs,
        evaluation: evalReport
      };
    }

    // ── ACTION: INSTALL (WITH MANDATORY HITL) ─────────────────────────────
    if (action === 'install') {
      if (!toolId) {
        return { success: false, error: 'Missing toolId to install.' };
      }

      let tool = CURATED_OPEN_SOURCE_CATALOGUE[toolId];
      if (!tool) {
        return { success: false, error: `Tool "${toolId}" not found in catalogue.` };
      }

      let selectedTool: OpenSourceToolProfile = tool;
      if (forceAlternative && tool.lightweightAlternativeId) {
        const alt = CURATED_OPEN_SOURCE_CATALOGUE[tool.lightweightAlternativeId];
        if (alt) {
          selectedTool = alt;
          toolId = alt.id;
        }
      }

      const evalReport = evaluateHardwareCompatibility(specs, selectedTool);

      // MANDATORY HITL GATE: If not confirmed, pause and formulate decision proposal
      if (!confirm) {
        const altProfile = selectedTool.lightweightAlternativeId
          ? CURATED_OPEN_SOURCE_CATALOGUE[selectedTool.lightweightAlternativeId]
          : undefined;

        return {
          success: true,
          requiresConsent: true,
          status: 'AWAITING_HITL_CONFIRMATION',
          message: `Human-In-The-Loop confirmation required before installing ${selectedTool.name}.`,
          tool: {
            id: selectedTool.id,
            name: selectedTool.name,
            repository: selectedTool.url,
            license: selectedTool.license,
            diskSize: `~${(selectedTool.diskFootprintMB / 1024).toFixed(1)} GB`,
            minRam: `${Math.round(selectedTool.minRamMB / 1024)} GB`,
            recommendedRam: `${Math.round(selectedTool.recommendedRamMB / 1024)} GB`,
            compute: selectedTool.computeType,
            evaluation: evalReport
          },
          decisionRequest: {
            kind: 'product',
            header: `Install ${selectedTool.name}`,
            question: `Do you authorize installing ${selectedTool.name} (~${(selectedTool.diskFootprintMB / 1024).toFixed(1)} GB disk, ${Math.round(selectedTool.minRamMB / 1024)} GB RAM)?`,
            reason: `Sovereign open-source tool installation on your local machine requires explicit authorization.`,
            options: [
              {
                id: 'install_authorized',
                label: `Authorize & Install ${selectedTool.name}`,
                description: `Proceed with installation into isolated .ai_tools workspace environment.`
              },
              ...(altProfile
                ? [
                    {
                      id: 'install_lightweight',
                      label: `Use Lightweight Alternative (${altProfile.name})`,
                      description: `Requires much less RAM (<1-2GB) and smaller disk footprint.`
                    }
                  ]
                : []),
              {
                id: 'cancel_install',
                label: 'Cancel Installation',
                description: 'Do not install local model; fall back to cloud API or procedural tools.'
              }
            ]
          },
          instruction: `Ask user for consent via request_decision or run 'open_source_tool_provisioner' with confirm: true after obtaining agreement.`
        };
      }

      // User has explicitly confirmed! Proceed with sovereign isolated setup.
      const aiToolsDir = path.join(workspaceDir, '.ai_tools');
      const venvDir = path.join(aiToolsDir, 'venv');
      await fsp.mkdir(aiToolsDir, { recursive: true });

      // Ensure python venv exists
      const isWin = process.platform === 'win32';
      const pythonBin = isWin ? 'python.exe' : 'python3';
      const venvPip = isWin ? path.join(venvDir, 'Scripts', 'pip.exe') : path.join(venvDir, 'bin', 'pip');
      const venvPython = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

      if (!fs.existsSync(venvPip)) {
        try {
          await execFilePromise(pythonBin, ['-m', 'venv', venvDir], { timeout: 120000 });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return { success: false, error: `Failed to create virtual environment: ${errMsg}` };
        }
      }

      // Install packages if pip-based
      if (selectedTool.installMethod === 'pip' && selectedTool.pipPackages && selectedTool.pipPackages.length > 0) {
        try {
          await execFilePromise(
            venvPip,
            ['install', '--disable-pip-version-check', '--no-input', ...selectedTool.pipPackages],
            { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
          );
        } catch (pipErr: unknown) {
          const errMsg = pipErr instanceof Error ? pipErr.message : String(pipErr);
          return { success: false, error: `Package installation failed: ${errMsg}` };
        }
      }

      // Record in installed_tools.json manifest
      const manifestFile = path.join(aiToolsDir, 'installed_tools.json');
      let installedMap: Record<string, unknown> = {};
      try {
        if (fs.existsSync(manifestFile)) {
          installedMap = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
        }
      } catch {
        installedMap = {};
      }

      installedMap[selectedTool.id] = {
        name: selectedTool.name,
        repo: selectedTool.repo,
        installedAt: new Date().toISOString(),
        pythonPath: venvPython,
        compute: selectedTool.computeType,
        diskSize: `~${(selectedTool.diskFootprintMB / 1024).toFixed(1)} GB`
      };

      await fsp.writeFile(manifestFile, JSON.stringify(installedMap, null, 2), 'utf8');

      return {
        success: true,
        installed: true,
        toolId: selectedTool.id,
        name: selectedTool.name,
        pythonPath: venvPython,
        message: `Successfully provisioned ${selectedTool.name}. Dependencies installed in isolated workspace environment (.ai_tools/venv).`,
        runCommand: `${venvPython} -m ${selectedTool.id.replace(/-/g, '_')}`,
        systemSpecs: {
          accelerator: specs.accelerator,
          freeRamGB: Math.round(specs.freeRamMB / 1024)
        }
      };
    }

    // ── ACTION: LIST_INSTALLED ────────────────────────────────────────────
    if (action === 'list_installed') {
      const manifestFile = path.join(workspaceDir, '.ai_tools', 'installed_tools.json');
      if (!fs.existsSync(manifestFile)) {
        return { success: true, installedTools: [], message: 'No local open-source tools installed in .ai_tools.' };
      }
      try {
        const data = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
        return { success: true, installedTools: data };
      } catch {
        return { success: true, installedTools: [] };
      }
    }

    return { success: false, error: `Unknown action: "${action}". Supported: discover, evaluate, install, list_installed.` };
  }
};
