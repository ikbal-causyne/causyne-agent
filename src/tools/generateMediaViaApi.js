import { causyneHome, resolveUserPath } from '../utils/paths.js';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';
import { validateToolArguments } from './argumentValidation.js';
function resolveApprovalHost(sandbox) {
    if (typeof sandbox?.waitForApproval === 'function')
        return sandbox;
    if (typeof sandbox?.parentLoop?.waitForApproval === 'function')
        return sandbox.parentLoop;
    return undefined;
}
function buildMediaSignal(signal, timeoutMs = 120_000) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadConfig } from '../config.js';
import { isDevEmulator } from '../devMode.js';
import { TokenTracker } from '../tokenTracker.js';
// Reject HTML/JSON error payloads before saving media output.
function validateMagicNumbers(buffer) {
    if (buffer.length < 4)
        return false;
    const hex = buffer.toString('hex', 0, 8).toUpperCase();
    // JPEG: FFD8FFE0, PNG: 89504E47, WAV: 52494646 (RIFF), MP3: 494433 (ID3)
    if (hex.startsWith('FFD8FF'))
        return true; // JPEG
    if (hex.startsWith('89504E47'))
        return true; // PNG
    if (hex.startsWith('52494646'))
        return true; // WAV/RIFF
    if (hex.startsWith('494433') || hex.startsWith('FFFB') || hex.startsWith('FFFA') || hex.startsWith('FFF3') || hex.startsWith('FFF2') || hex.startsWith('FFE3'))
        return true; // MP3 (ID3 or MPEG frame sync)
    // MP4 video container check: valid ISO BMFF box size (4 bytes) followed by box type 'ftyp', 'moov', 'mdat', or 'free'
    if (buffer.length >= 8) {
        const boxSize = buffer.readUInt32BE(0);
        const boxType = buffer.toString('ascii', 4, 8);
        const validBoxSize = boxSize === 0 || boxSize === 1 || (boxSize >= 8 && boxSize <= buffer.length);
        if (validBoxSize && ['ftyp', 'moov', 'mdat', 'free'].includes(boxType))
            return true;
    }
    return false;
}
const CACHE_DIR = path.join(causyneHome(), 'media-cache');
/**
 * Helper to trigger execution path isolation for specialized API providers (Gemini Veo/Imagen, OpenAI DALL-E, Qwen Wan)
 */
async function routeMultimediaRequest(args, config, sandbox, tokenTracker) {
    const { mediaType, prompt, targetProvider = 'auto', targetModel, durationSeconds = 5 } = args;
    // Auto-resolve provider based on available keys and media type
    let provider = targetProvider;
    let model = targetModel || args.model;
    if (provider === 'auto') {
        if (mediaType === 'video_animation') {
            if (config.geminiApiKey || (config.provider === 'gemini' && config.apiKey)) {
                provider = 'gemini';
                model = model || 'veo-2.0-generate-001';
            }
            else if (config.dashscopeApiKey || (config.provider === 'qwen' && config.apiKey)) {
                provider = 'qwen';
                model = model || 'wanx-v2.1-t2v-turbo';
            }
            else if (config.openaiApiKey || (config.provider === 'openai' && config.apiKey)) {
                provider = 'openai';
                model = model || 'sora-2';
            }
        }
        else if (mediaType === 'image') {
            // Reuse an already configured provider before selecting another service.
            if (config.museApiKey || ((config.provider === 'muse' || config.provider === 'meta') && config.apiKey)) {
                provider = 'muse';
                model = model || 'muse-image-1.0';
            }
            else if (config.geminiApiKey || (config.provider === 'gemini' && config.apiKey)) {
                provider = 'gemini';
                model = model || 'imagen-3.0-generate-002';
            }
            else if (config.openaiApiKey || (config.provider === 'openai' && config.apiKey)) {
                provider = 'openai';
                model = model || 'dall-e-3';
            }
            else {
                provider = 'pollinations';
                model = model || 'flux';
            }
        }
    }
    // Pollinations uses its authenticated binary-response endpoint below.
    if (provider === 'pollinations' || provider === 'local' || !['gemini', 'openai', 'qwen', 'muse'].includes(provider)) {
        return null;
    }
    if (provider === 'qwen') {
        return { success: false, code: 'MEDIA_PROVIDER_UNAVAILABLE', error: `No supported authenticated ${mediaType} endpoint is configured for ${provider}. No media artifact was produced.` };
    }
    // Calculate estimated cost and equivalent tokens
    const quantity = mediaType === 'video_animation' ? durationSeconds : 1;
    const unitPrice = tokenTracker.getMediaPricing(provider, model || '', mediaType);
    const estimatedCost = unitPrice * quantity;
    const estimatedTokens = Math.round(estimatedCost / 0.000002);
    // Pre-Flight Consent Modal (`approval_request`) for Paid API Handoffs (unless in Mode C/Super Max and pre-approved)
    const approvalHost = resolveApprovalHost(sandbox);
    if (approvalHost && typeof approvalHost.waitForApproval === 'function') {
        // The paid-media consent modal is skipped in Mode C (pre-approved) and in
        // hardened developer emulator mode (secret-gated — see devMode.js).
        if (!isDevEmulator(config) && config.autonomyMode !== 'C') {
            const approvalId = `media_${crypto.randomUUID()}`;
            if (typeof approvalHost.emitEvent === 'function') {
                approvalHost.emitEvent({
                    type: 'approval_request',
                    toolCallId: approvalId,
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
            const approved = await approvalHost.waitForApproval(approvalId);
            if (!approved) {
                return { success: false, code: 'MEDIA_APPROVAL_DENIED', error: 'Paid media generation was declined. No media artifact was produced.' };
            }
        }
    }
    // Check the estimated monetary ceiling before requesting generation. A failed
    // request must not be recorded as successfully generated media.
    const daily = await tokenTracker.getDailyUsage();
    if (tokenTracker.budget.enabled && tokenTracker.budget.hardStop && tokenTracker.budget.maxCostUsd
        && (daily.totalCostUsd || 0) + estimatedCost > tokenTracker.budget.maxCostUsd) {
        return { success: false, code: 'MEDIA_BUDGET_EXCEEDED', error: 'The estimated media request would exceed the configured monetary budget.' };
    }
    // Execute actual REST call to the specialized provider (Gemini / OpenAI / Qwen)
    let targetUrl = '';
    const activeProvider = config.provider === 'meta' ? 'muse' : config.provider;
    const apiKey = config[`${provider}ApiKey`] || (provider === 'qwen' ? config.dashscopeApiKey : undefined) || (activeProvider === provider ? config.apiKey : undefined);
    let headers = { 'Content-Type': 'application/json' };
    let body = {};
    if (provider === 'gemini') {
        model = model || (mediaType === 'video_animation' ? 'veo-2.0-generate-001' : 'imagen-3.0-generate-002');
        if (!/^[A-Za-z0-9._-]+$/.test(model)) {
            return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'Invalid Gemini media model identifier.' };
        }
        const encodedModel = encodeURIComponent(model);
        headers['x-goog-api-key'] = apiKey;
        if (mediaType === 'video_animation') {
            targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:predict`;
            body = { instances: [{ prompt }], parameters: { durationSeconds } };
        }
        else {
            targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:predict`;
            body = { instances: [{ prompt }], parameters: { sampleCount: 1 } };
        }
    }
    else if (provider === 'muse') {
        // Muse Image is the only model in the family that outputs images, and there
        // is no video model at all — a video request must fall through to the
        // sovereign hierarchy rather than be billed against an image endpoint.
        if (mediaType !== 'image')
            return null;
        targetUrl = 'https://api.meta.ai/v1/images/generations';
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = { model: model || 'muse-image-1.0', prompt, n: 1, response_format: 'b64_json' };
    }
    else if (provider === 'openai') {
        if (mediaType === 'image') {
            targetUrl = 'https://api.openai.com/v1/images/generations';
            headers['Authorization'] = `Bearer ${apiKey}`;
            body = { model: model || 'dall-e-3', prompt, n: 1, response_format: 'b64_json' };
        }
        else {
            targetUrl = 'https://api.openai.com/v1/video/generations';
            headers['Authorization'] = `Bearer ${apiKey}`;
            body = { model: model || 'sora-2', prompt };
        }
    }
    if (!targetUrl || !apiKey)
        return { success: false, code: 'MEDIA_PROVIDER_UNAVAILABLE', error: `No supported authenticated ${mediaType} endpoint is configured for ${provider}. No media artifact was produced.` };
    const response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: buildMediaSignal(sandbox?.signal) });
    if (!response.ok)
        return { success: false, code: 'MEDIA_PROVIDER_ERROR', status: response.status, retryable: response.status === 429 || response.status >= 500, error: `Media provider ${provider} returned HTTP ${response.status}. No media artifact was produced.` };
    const data = await response.json();
    let buffer = null;
    if ((provider === 'openai' || provider === 'muse') && data.data && data.data[0]?.b64_json) {
        buffer = Buffer.from(data.data[0].b64_json, 'base64');
    }
    else if (provider === 'gemini' && data.predictions && data.predictions[0]?.bytesBase64Encoded) {
        buffer = Buffer.from(data.predictions[0].bytesBase64Encoded, 'base64');
    }
    else if (data.url || (data.data && data.data[0]?.url)) {
        const mediaUrl = data.url || data.data[0].url;
        const verifiedUrl = await assertPublicWebUrl(mediaUrl);
        if (verifiedUrl.protocol !== 'https:') {
            return { success: false, code: 'INVALID_MEDIA_RESPONSE', error: `Provider ${provider} returned a non-HTTPS media download URL.` };
        }
        const mediaResp = await fetch(verifiedUrl, { redirect: 'error', signal: buildMediaSignal(sandbox?.signal) });
        if (!mediaResp.ok) {
            return { success: false, code: 'MEDIA_PROVIDER_ERROR', status: mediaResp.status, error: `Media download returned HTTP ${mediaResp.status}.` };
        }
        const declaredLen = Number(mediaResp.headers.get('content-length') ?? '0');
        if (Number.isFinite(declaredLen) && declaredLen > 50 * 1024 * 1024) {
            return { success: false, code: 'INVALID_MEDIA_RESPONSE', error: 'Media download exceeds 50 MB limit.' };
        }
        const ab = await mediaResp.arrayBuffer();
        if (ab.byteLength > 50 * 1024 * 1024) {
            return { success: false, code: 'INVALID_MEDIA_RESPONSE', error: 'Media download exceeds 50 MB limit.' };
        }
        buffer = Buffer.from(ab);
    }
    if (!buffer || !validateMagicNumbers(buffer))
        return { success: false, code: 'INVALID_MEDIA_RESPONSE', error: `Provider ${provider} did not return a supported media file. No artifact was produced.` };
    await tokenTracker.trackMediaUsage(provider, mediaType, model || '', quantity);
    return {
        success: true,
        buffer,
        provider,
        model: model || '',
        costUsd: estimatedCost,
        equivalentTokens: estimatedTokens
    };
}
export const generateMediaViaApi = {
    schema: {
        name: 'generate_media_via_api',
        description: 'Mode D / Auto-Router: Generate validated images, audio TTS, or video animations. Supports automatic multi-provider handoff (Gemini Veo/Imagen, DALL-E 3, Qwen Wan) with interactive user approval and configured provider routing. No artifact is produced when authentication or funding is unavailable.',
        parameters: {
            type: 'object',
            properties: {
                mediaType: { type: 'string', enum: ['image', 'audio_tts', 'video_animation'] },
                prompt: { type: 'string' },
                outputPath: { type: 'string', description: 'Destination in the selected workspace. Omit to use a unique generated filename there.' },
                width: { type: 'number' },
                height: { type: 'number' },
                model: { type: 'string' },
                voice: { type: 'string' },
                targetProvider: { type: 'string', enum: ['auto', 'gemini', 'openai', 'qwen', 'pollinations'], description: 'Optional provider routing for specialized models.' },
                targetModel: { type: 'string', description: 'Optional exact model name (e.g. veo-2.0-generate-001, imagen-3.0-generate-002, dall-e-3).' },
                durationSeconds: { type: 'number', description: 'Duration in seconds for video animations (default 5).' }
            },
            required: ['mediaType', 'prompt']
        }
    },
    execute: async (input, sandbox) => {
        try {
            const issues = validateToolArguments(input, generateMediaViaApi.schema.parameters);
            if (issues.length)
                return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: issues.join('; '), expectedSchema: generateMediaViaApi.schema.parameters };
            const args = input;
            const workspaceRoot = sandbox?.parentLoop?.workspaceRoot || sandbox?.workspaceRoot || sandbox?.workspacePaths?.[0] || process.cwd();
            const pathPolicy = sandbox?.parentLoop?.sandbox || sandbox;
            if (!args.prompt.trim())
                return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'prompt must be a nonempty string' };
            if (args.durationSeconds !== undefined && (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0 || args.durationSeconds > 60)) {
                return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'durationSeconds must be a finite number between 0 and 60' };
            }
            if (args.width !== undefined && (!Number.isFinite(args.width) || args.width < 64 || args.width > 4096)) {
                return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'width must be between 64 and 4096' };
            }
            if (args.height !== undefined && (!Number.isFinite(args.height) || args.height < 64 || args.height > 4096)) {
                return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'height must be between 64 and 4096' };
            }
            const { mediaType = 'image', prompt = '', width, height, model, voice, targetProvider, targetModel, durationSeconds } = args || {};
            const ext = mediaType === 'audio_tts' ? 'mp3' : mediaType === 'video_animation' ? 'mp4' : 'png';
            const rawOutputPath = typeof args?.outputPath === 'string' && args.outputPath.trim()
                ? args.outputPath.trim()
                : path.join(workspaceRoot, `generated_media_${crypto.randomUUID()}.${ext}`);
            const isHomePath = rawOutputPath === '~' || rawOutputPath.startsWith('~/') || rawOutputPath.startsWith('~\\');
            const outputPath = isHomePath ? resolveUserPath(rawOutputPath) : path.resolve(workspaceRoot, rawOutputPath);
            if (pathPolicy?.isPathAllowed && !pathPolicy.isPathAllowed(outputPath)) {
                return { success: false, error: `Path outside allowed workspace: ${outputPath}` };
            }
            try {
                const existingStat = fs.lstatSync(outputPath);
                if (existingStat.isDirectory()) {
                    return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: `outputPath is an existing directory: ${outputPath}` };
                }
                if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
                    return { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: `Refusing to overwrite symlink or non-regular file: ${outputPath}` };
                }
            }
            catch (statErr) {
                if (statErr?.code !== 'ENOENT') {
                    return { success: false, error: errorMessage(statErr) };
                }
            }
            const outputDir = path.dirname(outputPath);
            if (!fs.existsSync(outputDir))
                fs.mkdirSync(outputDir, { recursive: true });
            if (!fs.existsSync(CACHE_DIR))
                fs.mkdirSync(CACHE_DIR, { recursive: true });
            // Cache complete media responses.
            const promptHash = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
            const cachedFile = path.join(CACHE_DIR, promptHash);
            if (fs.existsSync(cachedFile) && validateMagicNumbers(fs.readFileSync(cachedFile))) {
                fs.copyFileSync(cachedFile, outputPath);
                return {
                    success: true,
                    message: `Cache Hit: Loaded instantly from local AI cache. Saved to ${outputPath}`,
                    sizeBytes: fs.statSync(outputPath).size,
                    mode: 'D / Router (Cached)'
                };
            }
            const config = loadConfig();
            const tokenTracker = new TokenTracker();
            // Use the configured media provider first.
            const routeResult = await routeMultimediaRequest(args, config, sandbox, tokenTracker);
            if (routeResult) {
                if (routeResult.success !== true || !routeResult.buffer)
                    return { ...routeResult, success: false };
                fs.writeFileSync(cachedFile, routeResult.buffer);
                fs.writeFileSync(outputPath, routeResult.buffer);
                return {
                    success: true,
                    message: `Media saved via ${String(routeResult.provider).toUpperCase()} (${routeResult.model}) to ${outputPath}. Estimated cost: $${(routeResult.costUsd || 0).toFixed(2)}.`,
                    sizeBytes: routeResult.buffer.length,
                    mode: `API (${String(routeResult.provider).toUpperCase()})`
                };
            }
            // Pollinations generation requires user-configured credentials. Missing keys
            // are a configuration blocker, not a reason to retry anonymous requests.
            const pollinationsKey = config.pollinationsApiKey || process.env.POLLINATIONS_API_KEY;
            if (!pollinationsKey)
                return {
                    success: false, code: 'MEDIA_AUTH_REQUIRED', retryable: false,
                    error: 'Image/audio generation requires a configured media provider key. The anonymous Pollinations fallback is unavailable. No media artifact was produced.',
                    nextAction: 'Use another already configured capability when it satisfies the request. If procedural drawing is an appropriate alternative, identify it accurately. If a generation service is essential, report the missing credentials without repeatedly retrying or asking for secrets in chat.'
                };
            if (mediaType === 'video_animation')
                return { success: false, code: 'MEDIA_PROVIDER_UNAVAILABLE', error: 'No supported video endpoint is configured. No media artifact was produced.' };
            const approvalHost = resolveApprovalHost(sandbox);
            if (approvalHost?.waitForApproval && !isDevEmulator(config) && config.autonomyMode !== 'C') {
                const approvalId = `media_${crypto.randomUUID()}`;
                approvalHost.emitEvent?.({ type: 'approval_request', toolCallId: approvalId, tool: 'generate_media_via_api', args: { mediaType, targetProvider: 'pollinations' }, risk: 'monetary_cost' });
                if (!await approvalHost.waitForApproval(approvalId))
                    return { success: false, code: 'MEDIA_APPROVAL_DENIED', error: 'Media generation was declined. No artifact was produced.' };
            }
            const query = new URLSearchParams(mediaType === 'image'
                ? { width: String(width || 1024), height: String(height || 1024), model: model || targetModel || 'flux', seed: String(Date.now()) }
                : { voice: voice || 'nova', model: model || targetModel || 'openai-audio' });
            const targetUrl = `https://gen.pollinations.ai/${mediaType === 'image' ? 'image' : 'audio'}/${encodeURIComponent(prompt)}?${query}`;
            let buffer = null;
            let attempts = 0;
            while (attempts < 3) {
                attempts++;
                const response = await fetch(targetUrl, { headers: { Authorization: `Bearer ${pollinationsKey}` }, signal: buildMediaSignal(sandbox?.signal) });
                if (!response.ok) {
                    const retryable = response.status === 429 || response.status >= 500;
                    if (!retryable || attempts === 3)
                        return {
                            success: false, code: 'MEDIA_PROVIDER_ERROR', status: response.status, attempts, retryable,
                            error: `Pollinations returned HTTP ${response.status}. No media artifact was produced.`,
                            nextAction: [401, 402, 403].includes(response.status) ? 'The user must check provider authentication, permissions, or balance before retrying.' : 'Check provider availability before retrying.'
                        };
                    await new Promise((resolve, reject) => {
                        const signal = sandbox?.signal;
                        const abort = () => { clearTimeout(timer); reject(new Error('Media generation aborted')); };
                        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, attempts * 1000);
                        if (signal?.aborted)
                            abort();
                        else
                            signal?.addEventListener('abort', abort, { once: true });
                    });
                    continue;
                }
                const candidate = Buffer.from(await response.arrayBuffer());
                if (!validateMagicNumbers(candidate))
                    return { success: false, code: 'INVALID_MEDIA_RESPONSE', attempts, error: 'Provider response is not a supported media file. No artifact was produced.' };
                buffer = candidate;
                break;
            }
            if (!buffer)
                return { success: false, error: 'Media generation did not produce a file.' };
            // Generation pricing is service-dependent; do not advertise this route as free.
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
        }
        catch (err) {
            return { success: false, error: errorMessage(err) };
        }
    }
};
