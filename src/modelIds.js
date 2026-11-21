// Canonical model identifiers.
//
// WHY THIS EXISTS: earlier configuration accepted Anthropic model ids with
// dots, while the canonical ids use dashes. Nothing normalised them, so the
// invalid string went straight into the provider request payload.
//
// THE RULE IS DELIBERATELY NARROW. A blanket dot→dash replacement would
// destroy every other vendor's ids, because dots are CORRECT for them:
// `gpt-5.6-sol`, `qwen3.7-max`, `gemini-3.5-flash`, `grok-4.5`,
// `kimi-k2.7-code`, `muse-spark-1.3`. Only the Anthropic family is rewritten,
// and no published Anthropic id contains a dot, so the mapping is lossless.
/** Vendor prefixes whose canonical ids never contain a dot. */
const DOTLESS_MODEL_FAMILIES = ['claude-'];
export function canonicalModelId(model) {
    if (typeof model !== 'string' || model === '' || model.length > 256)
        return model;
    const lowered = model.toLowerCase();
    for (const family of DOTLESS_MODEL_FAMILIES) {
        if (lowered.startsWith(family))
            return model.replace(/\./g, '-');
    }
    return model;
}
