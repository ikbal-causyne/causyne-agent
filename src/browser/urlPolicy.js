import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
const DNS_CACHE_MS = 5 * 60_000;
const hostCache = new Map();
function isPrivateIpv4(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a = 0, b = 0, c = 0] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0 && (c === 0 || c === 2))
        || (a === 192 && b === 88 && c === 99)
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224;
}
function isPrivateIpv6(address) {
    const normalized = address.toLowerCase().split('%')[0] ?? '';
    let canonical = normalized;
    try {
        canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    }
    catch {
        return true;
    }
    if (canonical === '::' || canonical === '::1')
        return true;
    if (canonical.startsWith('fc') || canonical.startsWith('fd') || canonical.startsWith('fe8')
        || canonical.startsWith('fe9') || canonical.startsWith('fea') || canonical.startsWith('feb')
        || canonical.startsWith('fec') || canonical.startsWith('fed') || canonical.startsWith('fee')
        || canonical.startsWith('fef') || canonical.startsWith('ff') || canonical.startsWith('2001:db8:')
        || canonical === '2001:db8::' || canonical.startsWith('64:ff9b:'))
        return true;
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
    }
    if (canonical.startsWith('::ffff:'))
        return true;
    return false;
}
export function isPrivateAddress(address) {
    const version = isIP(address);
    if (version === 4)
        return isPrivateIpv4(address);
    if (version === 6)
        return isPrivateIpv6(address);
    return true;
}
function blockedHostname(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return host === 'localhost'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
        || host.endsWith('.internal')
        || host === 'metadata.google.internal';
}
async function resolvedAddresses(hostname) {
    const cached = hostCache.get(hostname);
    if (cached && cached.expiresAt > Date.now())
        return cached.addresses;
    const results = await lookup(hostname, { all: true, verbatim: true });
    const addresses = [...new Set(results.map(result => result.address))];
    hostCache.set(hostname, { expiresAt: Date.now() + DNS_CACHE_MS, addresses });
    return addresses;
}
export function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost'))
        return true;
    if (/^127(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/.test(host))
        return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1')
        return true;
    return false;
}
export async function assertPublicWebUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('URL must be absolute and valid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https URLs are allowed');
    }
    if (url.username || url.password)
        throw new Error('URLs containing credentials are not allowed');
    if (blockedHostname(url.hostname))
        throw new Error('Local and internal hostnames are not allowed');
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    const literalVersion = isIP(literalHost);
    const addresses = literalVersion ? [literalHost] : await resolvedAddresses(url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        throw new Error('Local, private, link-local, multicast, and reserved network addresses are not allowed');
    }
    return url;
}
export async function assertBrowserNavigableUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('URL must be absolute and valid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https URLs are allowed');
    }
    if (url.username || url.password)
        throw new Error('URLs containing credentials are not allowed');
    if (isLoopbackHost(url.hostname)) {
        return url;
    }
    if (blockedHostname(url.hostname))
        throw new Error('Local and internal hostnames are not allowed');
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    const literalVersion = isIP(literalHost);
    const addresses = literalVersion ? [literalHost] : await resolvedAddresses(url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        throw new Error('Local, private, link-local, multicast, and reserved network addresses are not allowed');
    }
    return url;
}
export function clearUrlPolicyCache() {
    hostCache.clear();
}
