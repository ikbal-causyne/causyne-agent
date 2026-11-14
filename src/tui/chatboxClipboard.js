// Chatbox Clipboard Manager: surgical operations for copy, paste, and CRLF normalization.
// Supports native terminal mouse selection, readline kill/yank, Alt+C/Alt+W/Alt+V, and /copy /paste commands.
import { readClipboardSync, writeClipboardSync, emitOsc52Copy } from './clipboardSync.js';
import { stripAnsi } from './text.js';
import { readClipboardImageSync, formatByteSize, loadLocalImageAttachment, extractPastedFilePath, isLocalImageFile } from './clipboardImage.js';
export { loadLocalImageAttachment, extractPastedFilePath, isLocalImageFile };
/**
 * Clean up text copied or pasted: normalize Windows CRLF and classic Mac CR to LF,
 * remove null bytes and non-printable control characters while preserving valid newlines and tabs.
 */
export function normalizeClipboardText(raw) {
    if (typeof raw !== 'string')
        return '';
    // Strip CSI/OSC *before* removing C0; deleting ESC first leaves `[31m`
    // and mouse-control tails as user-visible text. Preserve LF and TAB.
    return stripAnsi(raw)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
/**
 * Copy text to system clipboard and terminal emulator (via OSC 52).
 */
export function copyToClipboard(text) {
    if (typeof text !== 'string' || text.length === 0)
        return false;
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
 * Seamlessly supports both text and screenshot images from system clipboard,
 * as well as drag-and-dropped local image file paths and empty bracketed pastes.
 */
export function pasteIntoChatbox(prompt, fallbackText) {
    const MAX_CHATBOX_BYTES = 2 * 1024 * 1024;
    const clean = normalizeClipboardText(fallbackText);
    const fits = (text) => {
        const existing = prompt.editor.getText();
        if (Buffer.byteLength(existing, 'utf8') + Buffer.byteLength(text, 'utf8') <= MAX_CHATBOX_BYTES)
            return true;
        prompt.notice = 'Paste exceeds 2 MiB; input unchanged. Attach the file instead.';
        prompt.scheduleDraw();
        return false;
    };
    if (clean && !fits(clean))
        return { success: false, notice: prompt.notice, text: '' };
    // 1. If fallbackText was provided (e.g. drag & drop or file paste), check if it's a local image file
    if (clean) {
        const filePath = extractPastedFilePath(clean);
        const localImg = loadLocalImageAttachment(filePath);
        if (localImg) {
            if (!Array.isArray(prompt.pendingAttachments)) {
                prompt.pendingAttachments = [];
            }
            prompt.pendingAttachments.push(localImg);
            const index = prompt.pendingAttachments.length;
            const tag = `[Image ${index}] `;
            prompt.editor.insert(tag);
            if (typeof prompt.refreshCompletion === 'function') {
                prompt.refreshCompletion();
            }
            prompt.notice = `attached image ${index} (${formatByteSize(localImg.size)})`;
            prompt.scheduleDraw();
            return { success: true, notice: prompt.notice, text: tag, isImage: true };
        }
    }
    // 2. If fallbackText was empty (empty bracketed paste from Cmd+V in terminal when an image is copied)
    // OR no fallbackText was passed (user pressed Ctrl+V, Alt+V, or typed /paste):
    // Probe system clipboard for screenshot / image FIRST!
    if (!clean) {
        const img = readClipboardImageSync();
        if (img) {
            if (!Array.isArray(prompt.pendingAttachments)) {
                prompt.pendingAttachments = [];
            }
            prompt.pendingAttachments.push(img);
            const index = prompt.pendingAttachments.length;
            const tag = `[Image ${index}] `;
            prompt.editor.insert(tag);
            if (typeof prompt.refreshCompletion === 'function') {
                prompt.refreshCompletion();
            }
            prompt.notice = `attached clipboard image ${index} (${formatByteSize(img.size)})`;
            prompt.scheduleDraw();
            return { success: true, notice: prompt.notice, text: tag, isImage: true };
        }
    }
    // 3. If fallbackText had non-image text: insert it into the editor
    if (clean) {
        prompt.editor.insert(clean);
        if (typeof prompt.refreshCompletion === 'function') {
            prompt.refreshCompletion();
        }
        prompt.notice = `pasted ${clean.split('\n').length} ${clean.includes('\n') ? 'lines' : 'line'} · ${Buffer.byteLength(clean, 'utf8').toLocaleString()} bytes`;
        prompt.scheduleDraw();
        return { success: true, notice: prompt.notice, text: clean, isImage: false };
    }
    // 4. No fallbackText provided and no clipboard image: read text from clipboard
    const clipText = normalizeClipboardText(readClipboardSync());
    if (clipText) {
        if (!fits(clipText))
            return { success: false, notice: prompt.notice, text: '' };
        const filePath = extractPastedFilePath(clipText);
        const localImg = loadLocalImageAttachment(filePath);
        if (localImg) {
            if (!Array.isArray(prompt.pendingAttachments)) {
                prompt.pendingAttachments = [];
            }
            prompt.pendingAttachments.push(localImg);
            const index = prompt.pendingAttachments.length;
            const tag = `[Image ${index}] `;
            prompt.editor.insert(tag);
            if (typeof prompt.refreshCompletion === 'function') {
                prompt.refreshCompletion();
            }
            prompt.notice = `attached image ${index} (${formatByteSize(localImg.size)})`;
            prompt.scheduleDraw();
            return { success: true, notice: prompt.notice, text: tag, isImage: true };
        }
        prompt.editor.insert(clipText);
        if (typeof prompt.refreshCompletion === 'function') {
            prompt.refreshCompletion();
        }
        prompt.notice = `pasted ${clipText.split('\n').length} ${clipText.includes('\n') ? 'lines' : 'line'} · ${Buffer.byteLength(clipText, 'utf8').toLocaleString()} bytes`;
        prompt.scheduleDraw();
        return { success: true, notice: prompt.notice, text: clipText, isImage: false };
    }
    // 5. Fallback to editor killRing
    if (prompt.editor.killRing) {
        prompt.editor.insert(prompt.editor.killRing);
        if (typeof prompt.refreshCompletion === 'function') {
            prompt.refreshCompletion();
        }
        prompt.notice = 'yanked from kill ring';
        prompt.scheduleDraw();
        return { success: true, notice: prompt.notice, text: prompt.editor.killRing, isImage: false };
    }
    prompt.notice = 'clipboard is empty';
    prompt.scheduleDraw();
    return { success: false, notice: prompt.notice, text: '' };
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
            if (typeof msg.content === 'string') {
                if (msg.content.trim())
                    return msg.content;
                continue;
            }
            if (Array.isArray(msg.content)) {
                const joined = msg.content
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
                if (joined.trim())
                    return joined;
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
        return {
            ok: res.success,
            output: res.success ? 'Copied chatbox input to clipboard.' : 'Chatbox input is currently empty.'
        };
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
    if (result.isImage) {
        return { ok: true, output: `Attached screenshot from clipboard (${result.text.trim()}).` };
    }
    return { ok: true, output: `Pasted ${result.text.length} characters into chatbox input.` };
}
