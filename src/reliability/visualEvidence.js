/** A rendered DOM is not proof that a user-requested 3D scene was visually inspected. */
export function inspect3DVisualEvidence(prompt, outcomes = []) {
    const text = String(prompt || '');
    const needs3DVisual = /\b(?:build|create|make|design|render|implement)\b[^\n]{0,150}\b(?:3[ -]?d|three\.?js|webgl)\b/i.test(text);
    if (!needs3DVisual)
        return { ok: true, required: false };
    // The host observer sets observedImage only when image bytes actually reached
    // a vision-capable provider. A file named screenshot.png or a browser
    // snapshot does not satisfy this condition.
    const latestMutation = outcomes.findLastIndex(item => item?.success === true &&
        /^(fs_write|fs_edit|MultiEdit|write_file|edit_file)$/i.test(String(item.tool || '')));
    const afterMutation = latestMutation < 0 ? outcomes : outcomes.slice(latestMutation + 1);
    if (afterMutation.some(item => item?.success === true && item?.observedImage === true)) {
        return { ok: true, required: true };
    }
    return {
        ok: false,
        required: true,
        reason: 'The user requested a Three.js/WebGL 3D deliverable, but no rendered image was actually inspected by a vision-capable model after the last change. A browser preview or DOM snapshot alone does not verify the 3D result. Report the scene as visually unverified, or capture and inspect an image before claiming completion.'
    };
}
