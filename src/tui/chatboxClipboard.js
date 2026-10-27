// Chatbox Clipboard Manager: surgical operations for copy, paste, and CRLF normalization.
// Supports native terminal mouse selection, readline kill/yank, Alt+C/Alt+W/Alt+V, and /copy /paste commands.
import { readClipboardSync, writeClipboardSync, emitOsc52Copy } from './clipboardSync.js';
/**
 * Clean up text copied or pasted: normalize Windows CRLF and classic Mac CR to LF,
 * remove null bytes and non-printable control characters while preserving valid newlines and tabs.
 */
export function normalizeClipboardText(raw) {
    if (typeof raw !== 'string')
        return '';
    return raw
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
/**
 * Copy text to system clipboard and terminal emulator (via OSC 52).
 */
export function copyToClipboard(text) {
    if (typeof text !== 'string' || text.length === 0)
        return false;
    emitOsc52Copy(text);
    return writeClipboardSync(text);
}
/**
 * Copy the current text in the chatbox prompt editor to system clipboard.
 */
export function copyChatboxInput(prompt) {
    const text = prompt.editor.getText();
    if (!text || !text.trim()) {
        prompt.notice = 'input is empty (nothing to copy)';
        prompt.scheduleDraw();
        return { success: false, notice: prompt.notice, text: '' };
    }
    const copied = copyToClipboard(text);
    if ('killRing' in prompt.editor) {
        prompt.editor.killRing = text;
    }
    prompt.notice = copied ? 'copied input to clipboard' : 'copied input to kill-ring';
    prompt.scheduleDraw();
    return { success: true, notice: prompt.notice, text };
}
/**
 * Paste clipboard content into the chatbox prompt editor.
 */
export function pasteIntoChatbox(prompt, fallbackText) {
    const raw = fallbackText ?? readClipboardSync();
    const text = normalizeClipboardText(raw);
    if (!text) {
        prompt.notice = 'clipboard is empty';
        prompt.scheduleDraw();
        return { success: false, notice: prompt.notice, text: '' };
    }
    prompt.editor.insert(text);
    if (typeof prompt.refreshCompletion === 'function') {
        prompt.refreshCompletion();
    }
    prompt.notice = 'pasted from clipboard';
    prompt.scheduleDraw();
    return { success: true, notice: prompt.notice, text };
}
/**
 * Extract the content of the last assistant turn from the conversation.
 */
export function extractLastAssistantTurn(loop) {
    if (!loop || !Array.isArray(loop.messages) || loop.messages.length === 0)
        return '';
    for (let i = loop.messages.length - 1; i >= 0; i--) {
        const msg = loop.messages[i];
        if (msg && msg.role === 'assistant') {
            if (typeof msg.content === 'string')
                return msg.content;
            if (Array.isArray(msg.content)) {
                return msg.content
                    .map((part) => {
                    if (typeof part === 'string')
                        return part;
                    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
                        return part.text;
                    }
                    return '';
                })
                    .filter(Boolean)
                    .join('\n');
            }
        }
    }
    return '';
}
/**
 * Command implementation for /copy.
 */
export function runCopyCommand(argv, ctx) {
    const target = argv[0]?.toLowerCase();
    if (target === 'last' || target === 'response' || target === 'assistant') {
        const lastTurn = extractLastAssistantTurn(ctx.loop);
        if (!lastTurn) {
            return { ok: false, output: 'No assistant response found in this session to copy.' };
        }
        copyToClipboard(lastTurn);
        if (ctx.prompt) {
            ctx.prompt.notice = 'copied last assistant response to clipboard';
            ctx.prompt.scheduleDraw();
        }
        return { ok: true, output: `Copied last assistant response (${lastTurn.length} characters) to clipboard.` };
    }
    if (target === 'input') {
        if (!ctx.prompt || ctx.prompt.editor.isEmpty) {
            return { ok: false, output: 'Chatbox input is currently empty.' };
        }
        const res = copyChatboxInput(ctx.prompt);
        return { ok: res.success, output: 'Copied chatbox input to clipboard.' };
    }
    if (argv.length > 0) {
        const customText = argv.join(' ');
        copyToClipboard(customText);
        if (ctx.prompt) {
            ctx.prompt.notice = 'copied text to clipboard';
            ctx.prompt.scheduleDraw();
        }
        return { ok: true, output: `Copied ${customText.length} characters to clipboard.` };
    }
    // Default: copy input if not empty, otherwise copy last assistant turn
    if (ctx.prompt && !ctx.prompt.editor.isEmpty) {
        const res = copyChatboxInput(ctx.prompt);
        return { ok: res.success, output: res.success ? 'Copied chatbox input to clipboard.' : 'Failed to write to system clipboard.' };
    }
    const lastTurn = extractLastAssistantTurn(ctx.loop);
    if (lastTurn) {
        copyToClipboard(lastTurn);
        if (ctx.prompt) {
            ctx.prompt.notice = 'copied last assistant response to clipboard';
            ctx.prompt.scheduleDraw();
        }
        return { ok: true, output: `Copied last assistant response (${lastTurn.length} characters) to clipboard.` };
    }
    return { ok: false, output: 'Nothing to copy. Chatbox input is empty and no previous responses exist.' };
}
/**
 * Command implementation for /paste.
 */
export function runPasteCommand(argv, ctx) {
    if (!ctx.prompt) {
        return { ok: false, output: 'The /paste command is only available in interactive chat mode.' };
    }
    const explicitText = argv.length > 0 ? argv.join(' ') : undefined;
    const result = pasteIntoChatbox(ctx.prompt, explicitText);
    if (!result.success) {
        return { ok: false, output: 'Clipboard is empty or unavailable.' };
    }
    return { ok: true, output: `Pasted ${result.text.length} characters into chatbox input.` };
}
