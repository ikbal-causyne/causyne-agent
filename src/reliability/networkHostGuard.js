/** Per-task host circuit breaker for repeated failed downloads through sysRun. */
export class NetworkHostGuard {
    maxFailures;
    failures = new Map();
    constructor(maxFailures = 2) {
        this.maxFailures = maxFailures;
        this.reset();
    }
    reset() {
        this.failures = new Map();
    }
    host(toolName, args) {
        if (!['sysRun', 'sysRunBg'].includes(toolName))
            return null;
        const command = typeof args?.command === 'string' ? args.command : '';
        // A command with no HTTP URL is outside this guard. It is not a security
        // parser and must never be substituted for the existing sandbox policy.
        const match = command.match(/https?:\/\/[^\s'"<>\\]+/i);
        if (!match)
            return null;
        try {
            const url = new URL(match[0].replace(/[),;]+$/, ''));
            if (!['http:', 'https:'].includes(url.protocol))
                return null;
            return url.hostname.toLowerCase();
        }
        catch {
            return null;
        }
    }
    before(toolName, args) {
        const host = this.host(toolName, args);
        if (!host || (this.failures.get(host) ?? 0) < this.maxFailures) {
            return { allowed: true, host };
        }
        return {
            allowed: false,
            host,
            error: `NETWORK_HOST_UNAVAILABLE: ${host} failed ${this.maxFailures} consecutive requests in this task. Do not call the same host again. Use a genuinely different source, or explain the missing download instead of claiming success.`
        };
    }
    after(toolName, args, result) {
        const host = this.host(toolName, args);
        if (!host)
            return;
        const success = result?.success === true && !result?.error;
        if (success) {
            this.failures.delete(host);
            return;
        }
        const message = String(result?.error || result?.output || '');
        if (/timed?\s*out|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|could not resolve|connection refused|ECONNREFUSED|connection reset|network unreachable/i.test(message)) {
            this.failures.set(host, (this.failures.get(host) ?? 0) + 1);
        }
    }
}
