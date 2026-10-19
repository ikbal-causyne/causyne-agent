import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { loadConfig } from '../config.js';
import { isDevEmulator } from '../devMode.js';
import { TokenTracker } from '../tokenTracker.js';

// Phase 5 & 6 AGI Upgrade: Validated Generation across Image, Audio, and Video (Magic Numbers)
function validateMagicNumbers(buffer) {
  if (buffer.length < 4) return false;
  const hex = buffer.toString('hex', 0, 8).toUpperCase();
  // JPEG: FFD8FFE0, PNG: 89504E47, WAV: 52494646 (RIFF), MP3: 494433 (ID3)
  if (hex.startsWith('FFD8FF')) return true; // JPEG
  if (hex.startsWith('89504E47')) return true; // PNG
  if (hex.startsWith('52494646')) return true; // WAV/RIFF
  if (hex.startsWith('494433')) return true; // MP3 (ID3)
  // MP4 video container check: box size (4 bytes) followed by box type 'ftyp' (66747970 in hex) or 'moov' or 'mdat'
  if (buffer.length >= 8) {
    const boxType = buffer.toString('ascii', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'free'].includes(boxType)) return true;
  }
  return false;
}

const CACHE_DIR = path.join(os.homedir(), '.causyne_media_cache');

/**
 * Helper to trigger execution path isolation for specialized API providers (Gemini Veo/Imagen, OpenAI DALL-E, Qwen Wan)
 */
async function routeMultimediaRequest(args, config, sandbox, tokenTracker) {
  const { mediaType, prompt, targetProvider = 'auto', targetModel, durationSeconds = 5 } = args;
  
  // Auto-resolve provider based on available keys and media type
  let provider = targetProvider;
  let model = targetModel;

  if (provider === 'auto') {
    if (mediaType === 'video_animation') {
      if (config.geminiApiKey || (config.provider === 'gemini' && config.apiKey)) {
        provider = 'gemini';
        model = model || 'veo-2.0-generate-001';
      } else if (config.dashscopeApiKey || (config.provider === 'qwen' && config.apiKey)) {
        provider = 'qwen';
        model = model || 'wanx-v2.1-t2v-turbo';
      } else if (config.openaiApiKey || (config.provider === 'openai' && config.apiKey)) {
        provider = 'openai';
        model = model || 'sora-2';
        // Fallback to Sovereign 5-Stage Hierarchy when no video API keys exist
        return {
          success: true,
          mode: 'Fallback (Sovereign 5-Stage Hierarchy)',
          message: `No paid video generation API key (Gemini/Qwen/OpenAI) configured. Stage 2 Fallback: Please invoke 'check_system_specs' FIRST to verify if local hardware (RAM >= 8GB, Disk > 10GB) can run local video models via 'manage_local_ai_dependencies'. If local hardware is insufficient or declined, transition to Stage 4 (web_search + web_fetch for stock video assets) or Stage 5 (execute_procedural_media Mode A for HTML5 Canvas/Python animation).`
        };
      }
    } else if (mediaType === 'image') {
      // Muse Image first when the session is already on Meta Model API: same key,
      // same base URL, and $0.01 an image is the cheapest paid route here by a
      // wide margin. It is checked before the others so a Muse user is not sent
      // to a second vendor they never configured.
      if (config.museApiKey || ((config.provider === 'muse' || config.provider === 'meta') && config.apiKey)) {
        provider = 'muse';
        model = model || 'muse-image-1.0';
      } else if (config.geminiApiKey || (config.provider === 'gemini' && config.apiKey)) {
        provider = 'gemini';
        model = model || 'imagen-3.0-generate-002';
      } else if (config.openaiApiKey || (config.provider === 'openai' && config.apiKey)) {
        provider = 'openai';
        model = model || 'dall-e-3';
      } else {
        provider = 'pollinations';
        model = model || 'flux';
      }
    }
  }

  // If routing to Pollinations or Free Mode, return null so standard execution continues
  if (provider === 'pollinations' || provider === 'local' || !['gemini', 'openai', 'qwen', 'muse'].includes(provider)) {
    return null;
  }

  // Calculate estimated cost and equivalent tokens
  const quantity = mediaType === 'video_animation' ? durationSeconds : 1;
  const unitPrice = tokenTracker.getMediaPricing(provider, model || '', mediaType);
  const estimatedCost = unitPrice * quantity;
  const estimatedTokens = Math.round(estimatedCost / 0.000002);

  // Pre-Flight Consent Modal (`approval_request`) for Paid API Handoffs (unless in Mode C/Super Max and pre-approved)
  if (sandbox && typeof sandbox.waitForApproval === 'function') {
    // The paid-media consent modal is skipped in Mode C (pre-approved) and in
    // hardened developer emulator mode (secret-gated — see devMode.js).
    if (!isDevEmulator(config) && config.autonomyMode !== 'C') {
      if (typeof sandbox.emitEvent === 'function') {
        sandbox.emitEvent({
          type: 'approval_request',
          toolCallId: `media_${Date.now()}`,
          tool: 'generate_media_via_api (Auto-Switch)',
          args: {
            targetProvider: provider.toUpperCase(),
            targetModel: model,
            mediaType,
            prompt,
            estimatedCostUsd: `$${estimatedCost.toFixed(2)}`,
            estimatedTokens: `~${estimatedTokens.toLocaleString()} Equivalent Tokens`
          },
          risk: 'monetary_cost'
        });
      }
      
      const approved = await sandbox.waitForApproval(`media_${Date.now()}`);
      if (!approved) {
        // User denied paid API -> Seamless routing across Sovereign 5-Stage Hierarchy
        if (mediaType === 'image') {
          return {
            fallbackToPollinations: true,
            message: `User denied Stage 1 paid API switch ($${estimatedCost.toFixed(2)}). Note: If local hardware allows and user prefers local processing, you may run 'check_system_specs' for Stage 2 (Local Stable Diffusion). Otherwise, auto-routing to free Pollinations.ai Mode D (Stage 3).`
          };
        } else {
          return {
            success: true,
            mode: 'Fallback (Stage 2 / Stage 4 / Stage 5)',
            message: `User denied Stage 1 paid API switch ($${estimatedCost.toFixed(2)}). Stage 2 Fallback: Please invoke 'check_system_specs' right now. If RAM >= 8GB and Disk > 10GB, propose local processing via 'manage_local_ai_dependencies' (e.g., Kokoro TTS/diffusers/whisper.cpp). If hardware is insufficient or user prefers no local downloads, transition to Stage 4 (web_search for existing royalty-free assets) or Stage 5 (execute_procedural_media Mode A).`
          };
        }
      }
    }
  }

  // Enforce budget kill-switch and track usage
  const tracking = await tokenTracker.trackMediaUsage(provider, mediaType, model, quantity);
  if (!tracking.allowed) {
    return {
      success: false,
      error: tracking.reason || `Monetary budget exceeded for ${provider} media generation ($${estimatedCost.toFixed(2)}).`
    };
  }

  // Execute actual REST call to the specialized provider (Gemini / OpenAI / Qwen)
  let targetUrl = '';
  let apiKey = config[`${provider}ApiKey`] || config.apiKey;
  let headers = { 'Content-Type': 'application/json' };
  let body = {};

  if (provider === 'gemini') {
    if (mediaType === 'video_animation') {
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
      body = { instances: [{ prompt }], parameters: { durationSeconds } };
    } else {
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
      body = { instances: [{ prompt }], parameters: { sampleCount: 1 } };
    }
  } else if (provider === 'muse') {
    // Muse Image is the only model in the family that outputs images, and there
    // is no video model at all — a video request must fall through to the
    // sovereign hierarchy rather than be billed against an image endpoint.
    if (mediaType !== 'image') return null;
    targetUrl = 'https://api.meta.ai/v1/images/generations';
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = { model: model || 'muse-image-1.0', prompt, n: 1, response_format: 'b64_json' };
  } else if (provider === 'openai') {
    if (mediaType === 'image') {
      targetUrl = 'https://api.openai.com/v1/images/generations';
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = { model: model || 'dall-e-3', prompt, n: 1, response_format: 'b64_json' };
    } else {
      targetUrl = 'https://api.openai.com/v1/video/generations';
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = { model: model || 'sora-2', prompt };
    }
  }

  const response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) {
    const errText = await response.text();
    // If API endpoint is unreachable or fails, fallback gracefully if image
    if (mediaType === 'image') {
      return {
        fallbackToPollinations: true,
        message: `Specialized provider (${provider}) returned error: ${response.status}. Falling back to free Pollinations.ai Mode D.`
      };
    }
    throw new Error(`Specialized ${provider} API failure (${response.status}): ${errText}`);
  }

  const data = await response.json();
  let buffer = null;

  
  if ((provider === 'openai' || provider === 'muse') && data.data && data.data[0]?.b64_json) {
    buffer = Buffer.from(data.data[0].b64_json, 'base64');
  } else if (provider === 'gemini' && data.predictions && data.predictions[0]?.bytesBase64Encoded) {
    buffer = Buffer.from(data.predictions[0].bytesBase64Encoded, 'base64');
  } else if (data.url || (data.data && data.data[0]?.url)) {
    const mediaUrl = data.url || data.data[0].url;
    const mediaResp = await fetch(mediaUrl);
    const ab = await mediaResp.arrayBuffer();
    buffer = Buffer.from(ab);
  }

  if (!buffer || !validateMagicNumbers(buffer)) {
    if (mediaType === 'image') {
      return { fallbackToPollinations: true, message: `Invalid buffer from ${provider}. Falling back to Pollinations.ai.` };
    }
    throw new Error(`Failed to extract valid media buffer from ${provider} API response.`);
  }

  return {
    success: true,
    buffer,
    provider,
    model,
    costUsd: estimatedCost,
    equivalentTokens: estimatedTokens
  };
}

export const generateMediaViaApi = {
  schema: {
    name: 'generate_media_via_api',
    description: 'Mode D / Auto-Router: Generate validated images, audio TTS, or video animations. Supports automatic multi-provider handoff (Gemini Veo/Imagen, DALL-E 3, Qwen Wan) with interactive user approval and free fallback.',
    parameters: {
      type: 'object',
      properties: {
        mediaType: { type: 'string', enum: ['image', 'audio_tts', 'video_animation'] },
        prompt: { type: 'string' },
        outputPath: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        model: { type: 'string' },
        voice: { type: 'string' },
        targetProvider: { type: 'string', enum: ['auto', 'gemini', 'openai', 'qwen', 'pollinations'], description: 'Optional provider routing for specialized models.' },
        targetModel: { type: 'string', description: 'Optional exact model name (e.g. veo-2.0-generate-001, imagen-3.0-generate-002, dall-e-3).' },
        durationSeconds: { type: 'number', description: 'Duration in seconds for video animations (default 5).' }
      },
      required: ['mediaType', 'prompt', 'outputPath']
    }
  },

  execute: async (args, sandbox) => {
    try {
      const { mediaType, prompt, width, height, model, voice, targetProvider, targetModel, durationSeconds } = args;
      let outputPath = args.outputPath.replace(/^~\//, os.homedir() + '/');
      outputPath = path.resolve(outputPath);

      if (sandbox && sandbox.isPathAllowed && !sandbox.isPathAllowed(outputPath)) {
        return { success: false, error: `Path outside allowed workspace: ${outputPath}` };
      }

      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

      // Phase 5 AGI Upgrade: Caching Layer
      const promptHash = crypto.createHash('sha256').update(`${mediaType}_${prompt}_${model || targetModel}_${voice || targetProvider}`).digest('hex');
      const cachedFile = path.join(CACHE_DIR, promptHash);
      if (fs.existsSync(cachedFile)) {
        fs.copyFileSync(cachedFile, outputPath);
        return { success: true, message: `Cache Hit: Loaded instantly from local AI cache. Saved to ${outputPath}`, mode: 'D / Router (Cached)' };
      }

      const config = loadConfig();
      const tokenTracker = new TokenTracker();

      // Attempt specialized AGI Auto-Routing first
      const routeResult = await routeMultimediaRequest(args, config, sandbox, tokenTracker);
      if (routeResult) {
        if (routeResult.fallbackToPollinations !== true) {
          if (!routeResult.buffer && routeResult.success) {
            // Handled fallback message (e.g. Mode A recommendation)
            return routeResult;
          }
          if (routeResult.buffer) {
            fs.writeFileSync(cachedFile, routeResult.buffer);
            fs.writeFileSync(outputPath, routeResult.buffer);
            return {
              success: true,
              message: `Media generated and validated via ${routeResult.provider.toUpperCase()} (${routeResult.model}). Cost: $${routeResult.costUsd.toFixed(2)} (~${routeResult.equivalentTokens} Equivalent Tokens). Saved to ${outputPath}`,
              sizeBytes: routeResult.buffer.length,
              mode: `Auto-Switch (${routeResult.provider.toUpperCase()})`
            };
          }
          if (routeResult.error) return routeResult;
        }
        // If routeResult.fallbackToPollinations is true, we proceed right into Pollinations below!
      }

      // Default / Fallback: Pollinations.ai Mode D
      let targetUrl = '';
      let fetchOptions = {};

      if (mediaType === 'image') {
        const imgWidth = width || 1024;
        const imgHeight = height || 1024;
        const imgModel = model || 'flux';
        targetUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${imgWidth}&height=${imgHeight}&model=${imgModel}&nologo=true&seed=${Date.now()}`;
      } else if (mediaType === 'audio_tts') {
        targetUrl = `https://api.pollinations.ai/tts?text=${encodeURIComponent(prompt)}&voice=${voice || 'nova'}`;
      } else {
        // Fallback across Sovereign 5-Stage Hierarchy when video_animation/music is routed to Pollinations
        return {
          success: true,
          mode: 'Fallback (Stage 2 / Stage 4 / Stage 5)',
          message: `Pollinations.ai (Stage 3) does not natively generate video animations or instrumental music directly. Stage 2 Fallback: Please invoke 'check_system_specs' right now to verify if local hardware (RAM >= 8GB) can run local models via 'manage_local_ai_dependencies'. If local hardware is insufficient or declined, transition to Stage 4 (web_search + web_fetch for stock video/music assets) or Stage 5 (execute_procedural_media Mode A for HTML5 Canvas/Python animation or WAV audio).`
        };
      }

      // Phase 5 AGI Upgrade: Auto-Retry Loop (3 retries, exponential backoff)
      let buffer = null;
      let attempts = 0;
      let lastError = '';
      
      while (attempts < 3) {
        attempts++;
        try {
          const response = await fetch(targetUrl, fetchOptions);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          
          const arrayBuffer = await response.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
          
          // Phase 5 AGI Upgrade: Magic Number Verification
          if (!validateMagicNumbers(buffer)) {
            throw new Error(`Invalid Magic Numbers (Corrupted/Unsupported format returned). Length: ${buffer.length}`);
          }
          break; // Success
        } catch (e) {
          lastError = e.message;
          if (attempts < 3) {
            await new Promise(res => setTimeout(res, attempts * 2000)); // Exponential backoff 2s, 4s
          }
        }
      }

      if (!buffer) {
        return { 
          success: false, 
          error: `Pollinations API (Stage 3) failed after 3 attempts. Last error: ${lastError}. Sovereign Hierarchy Fallback: Please transition to Stage 4 (web_search + web_fetch to locate matching royalty-free assets online) or Stage 5 (execute_procedural_media Mode A to generate procedurally from scratch).` 
        };
      }

      // Track free Mode D usage in Equivalent Units
      await tokenTracker.trackMediaUsage('pollinations', mediaType, 'flux', 1);

      // Write to cache and output
      fs.writeFileSync(cachedFile, buffer);
      fs.writeFileSync(outputPath, buffer);

      return {
        success: true,
        message: `Media generated, validated, and cached successfully via Pollinations Mode D. Saved to ${outputPath}`,
        sizeBytes: buffer.length,
        mode: 'D (Validated API)'
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
