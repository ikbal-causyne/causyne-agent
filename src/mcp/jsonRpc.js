

import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * A JSON-RPC channel over a child process's stdin/stdout.
 *
 * MCP frames stdio traffic as newline-delimited JSON. stderr is deliberately
 * NOT parsed — servers use it for human-readable logging, and treating it as
 * protocol is how a chatty server becomes a hang.
 */
export class StdioChannel {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.notificationHandler = null;
    this.stderrTail = [];
  }

  async open() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd || process.cwd(),
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', chunk => this.#ingest(chunk));

    // Kept only so a failure can be explained. Bounded, because a server that
    
    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', chunk => {
      this.stderrTail.push(String(chunk));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });

    this.child.on('exit', code => this.#failAll(new Error(`server exited (code ${code})${this.lastError()}`)));
    this.child.on('error', err => this.#failAll(err));

    // Surface a command that does not exist as an error rather than a timeout.
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.child.once('error', onError);
      setTimeout(() => { this.child.removeListener('error', onError); resolve(); }, 150);
    });
  }

  lastError() {
    const tail = this.stderrTail.join('').trim();
    return tail ? `: ${tail.slice(-400)}` : '';
  }

  #ingest(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (e) { continue; }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame) {
    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const { resolve, reject, timer } = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(timer);
      if (frame.error) reject(new Error(frame.error.message || 'JSON-RPC error'));
      else resolve(frame.result);
      return;
    }
    if (frame.method && this.notificationHandler) {
      try { this.notificationHandler(frame); } catch (e) {}
    }
  }

  #failAll(error) {
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  send(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.child || this.child.killed) return Promise.reject(new Error('channel is closed'));
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params: params ?? {} };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(frame) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    if (!this.child || this.child.killed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');
    } catch (e) {}
  }

  close() {
    this.#failAll(new Error('channel closed'));
    try { if (this.child) this.child.kill('SIGTERM'); } catch (e) {}
    this.child = null;
  }
}

/** A JSON-RPC channel over HTTP POST. One request, one response, no session. */
export class HttpChannel {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.nextId = 1;
    this.notificationHandler = null;
  }

  async open() {
    // Nothing to open. Validate the URL now so a typo fails at connect time
    // rather than on the first tool call.
    const parsed = new URL(this.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported transport protocol: ${parsed.protocol}`);
    }
  }

  async send(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${this.url}`);
    const frame = await response.json();
    if (frame.error) throw new Error(frame.error.message || 'JSON-RPC error');
    return frame.result;
  }

  notify() { /* HTTP transport has no notification channel */ }
  close() { /* nothing to close */ }
}
