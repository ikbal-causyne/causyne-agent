import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  detectSystemSpecs,
  evaluateHardwareCompatibility,
  searchCatalogue,
  openSourceToolProvisioner,
  CURATED_OPEN_SOURCE_CATALOGUE
} from '../src/tools/openSourceToolProvisioner.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';
import { PACKS } from '../src/toolPacks.js';

test('open source provisioner: detectSystemSpecs detects hardware, memory, and accelerator', async () => {
  const specs = await detectSystemSpecs();

  assert.ok(typeof specs.platform === 'string');
  assert.ok(typeof specs.architecture === 'string');
  assert.ok(specs.totalRamMB > 0);
  assert.ok(specs.freeRamMB > 0);
  assert.ok(specs.cpuCores > 0);
  assert.ok(typeof specs.cpuModel === 'string');
  assert.ok(typeof specs.diskSpaceGB === 'number');
  assert.ok(['Apple Silicon Metal (Unified Memory)', 'NVIDIA CUDA', 'CPU'].includes(specs.accelerator));
});

test('open source provisioner: searchCatalogue matches voice cloning and audio intents', () => {
  const voiceMatches = searchCatalogue('clone my voice');
  assert.ok(voiceMatches.some(t => t.id === 'f5-tts'));
  assert.ok(voiceMatches.some(t => t.id === 'kokoro-82m'));

  const transcriptionMatches = searchCatalogue('transcribe audio');
  assert.ok(transcriptionMatches.some(t => t.id === 'whisper-cpp'));

  const visionMatches = searchCatalogue('upscale image');
  assert.ok(visionMatches.some(t => t.id === 'realesrgan'));
});

test('open source provisioner: evaluateHardwareCompatibility correctly evaluates resource limits', () => {
  const highEndSpecs = {
    platform: 'darwin',
    architecture: 'arm64',
    totalRamMB: 32768,
    freeRamMB: 16384,
    cpuCores: 10,
    cpuModel: 'Apple M3 Pro',
    diskSpaceGB: 100,
    diskSpaceText: '100 GB available',
    accelerator: 'Apple Silicon Metal (Unified Memory)'
  };

  const f5tts = CURATED_OPEN_SOURCE_CATALOGUE['f5-tts'];
  const highEndReport = evaluateHardwareCompatibility(highEndSpecs, f5tts);
  assert.equal(highEndReport.compatible, true);
  assert.equal(highEndReport.status, 'READY_OPTIMAL');

  const lowEndSpecs = {
    platform: 'linux',
    architecture: 'x64',
    totalRamMB: 3000,
    freeRamMB: 800,
    cpuCores: 2,
    cpuModel: 'Intel Celeron',
    diskSpaceGB: 2,
    diskSpaceText: '2 GB available',
    accelerator: 'CPU'
  };

  const lowEndReport = evaluateHardwareCompatibility(lowEndSpecs, f5tts);
  assert.equal(lowEndReport.compatible, false);
  assert.equal(lowEndReport.status, 'INSUFFICIENT_HARDWARE');
  assert.ok(lowEndReport.reason.includes('Insufficient'));
});

test('open source provisioner: discover action returns ranked tools with compute and ram specs', async () => {
  const result = await openSourceToolProvisioner.execute({
    action: 'discover',
    intent: 'voice cloning'
  });

  assert.equal(result.success, true);
  assert.ok(result.systemSpecs);
  assert.ok(Array.isArray(result.recommendations));
  assert.ok(result.recommendations.length > 0);

  const first = result.recommendations[0];
  assert.ok(first.id);
  assert.ok(first.repoUrl);
  assert.ok(first.ramRequired);
  assert.ok(first.diskSize);
  assert.ok(first.compute);
  assert.ok(first.status);
});

test('open source provisioner: install without confirm flag enforces mandatory Human-In-The-Loop gate', async () => {
  const result = await openSourceToolProvisioner.execute({
    action: 'install',
    toolId: 'f5-tts',
    confirm: false
  });

  assert.equal(result.success, true);
  assert.equal(result.requiresConsent, true);
  assert.equal(result.status, 'AWAITING_HITL_CONFIRMATION');
  assert.ok(result.decisionRequest);
  assert.equal(result.decisionRequest.header, 'Install F5-TTS (Fairytale-5 Voice Cloning)');
  assert.ok(result.decisionRequest.options.length >= 2);
  assert.ok(result.decisionRequest.options.some(o => o.id === 'install_authorized'));
  assert.ok(result.decisionRequest.options.some(o => o.id === 'cancel_install'));
});

test('open source provisioner: registry and toolPack integration', () => {
  assert.ok(toolRegistry['open_source_tool_provisioner'], 'Must be registered in toolRegistry');
  assert.ok(TOOL_DEFINITIONS.some(d => d.name === 'open_source_tool_provisioner'), 'Must be in TOOL_DEFINITIONS');
  assert.ok(PACKS.media.includes('open_source_tool_provisioner'), 'Must belong to media tool pack');
});
