// Release-switch. Keep FALSE in development until the licensing terms, backend,
// payment provider, recovery process, and staged release have been approved.
// Changing this client flag is not a DRM boundary: the authoritative quota is
// enforced by the private service when the client connects.
export const LICENSE_ENFORCEMENT_ENABLED = false;
export const LICENSE_API_BASE = 'https://license.causyne.com';
export const LICENSE_PLAN_KEYS = Object.freeze([
  'monthly', 'annual', 'two_month_pass', 'two_year_pass'
]);
