// Release-switch. Keep FALSE in development until the licensing terms, backend,
// payment provider, recovery process, and staged release have been approved.
// Changing this client flag is not a DRM boundary: the authoritative quota is
// enforced by the private service when the client connects.
export const LICENSE_ENFORCEMENT_ENABLED = false;
export const LICENSE_API_BASE = 'https://license.causyne.com';
export const LICENSE_PLAN_KEYS = Object.freeze([
    'monthly', 'annual', 'two_month_pass', 'two_year_pass'
]);
export const LICENSE_CHECKOUT_ALLOWED_HOST_SUFFIX = 'paddle.com';
export const LICENSE_CHECKOUT_ALLOWED_HOST_SUFFIXES = Object.freeze([
    'paddle.com',
    'dodopayments.com',
    'causyne.com'
]);
export const MAX_ENTITLEMENT_RESPONSE_BYTES = 256 * 1024;
export function isValidLicensePlan(plan) {
    return typeof plan === 'string' && LICENSE_PLAN_KEYS.includes(plan);
}
export function isAllowedCheckoutHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host)
        return false;
    return LICENSE_CHECKOUT_ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
