import { spawn } from 'node:child_process';
import { AcpProvider } from './acp.js';
import { LLMProvider, type ProviderConfig, type ChatOptions, type ChatResponse, type ChatResponseAction } from './base.js';

export function isPiProvider(provider?: string | null): boolean {
  return typeof provider === 'string' && provider.toLowerCase() === 'pi';
}

export const PI_SETUP_PROVIDER = {
  id: 'pi', label: 'Pi coding agent', hint: 'local Pi RPC · uses Causyne tools',
  category: 'Peer Agent', model: 'default'
};

/** Pi collaborates over RPC with its configured capabilities intact. */
export class PiProvider extends LLMProvider {
  private readonly command: string;
  private readonly formatter: AcpProvider;

  constructor(config: ProviderConfig = {}) {
    super(config);
    this.command = config.command || 'pi';
    this.model = config.model || 'default';
    this.formatter = new AcpProvider({ provider: 'acp/opencode' });
    this.visionModels = [];
    this.audioModels = [];
  }

  override async chat(messages: unknown[], options: ChatOptions = {}): Promise<ChatResponse> {
    const args = ['--mode', 'rpc', '--no-session'];
    if (this.model !== 'default') args.push('--model', this.model);
    const cwd = typeof options.workspaceRoot === 'string' && options.workspaceRoot
      ? options.workspaceRoot : process.cwd();
    const prompt = this.formatter.formatConversation(messages, options.tools || [])
      .replace('over ACP.', 'over Pi RPC.');

    return new Promise<ChatResponse>((resolve, reject) => {
      const child = spawn(this.command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env, shell: false });
      let buffer = '';
      let stderr = '';
      let streamed = '';
      let finalText = '';
      let stopReason = '';
      let acknowledged = false;
      let settled = false;
      let finished = false;
      let usage: ChatResponse['usage'] = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
      const nativeActions = new Map<string, ChatResponseAction>();

      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', abort);
        child.stdin.end();
        if (!child.killed) child.kill();
      };
      const fail = (error: Error): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const complete = (): void => {
        if (finished || !acknowledged || !settled) return;
        if (stopReason === 'error' || stopReason === 'aborted') {
          fail(new Error(`Pi ended with ${stopReason}${stderr ? `: ${stderr.slice(-400)}` : ''}`));
          return;
        }
        finished = true;
        cleanup();
        const raw = finalText || streamed;
        resolve({
          content: raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(),
          usage,
          externalActions: [...nativeActions.values()].filter(action => action.status !== 'running'),
          toolCalls: this.formatter.extractToolCalls(raw)
        });
      };
      const abort = (): void => {
        const err = new Error('Pi request aborted');
        err.name = 'AbortError';
        fail(err);
      };
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener('abort', abort, { once: true });

      const handle = (record: Record<string, any>): void => {
        if (record.type === 'response' && record.id === 'causyne-state') {
          if (!record.success || !record.data?.model
            || record.data.model.provider === 'unknown' || record.data.model.id === 'unknown') {
            fail(new Error('Pi has no active model. Open Pi and configure a model login before selecting Pi in Causyne.'));
            return;
          }
          child.stdin.write(JSON.stringify({ id: 'causyne-prompt', type: 'prompt', message: prompt }) + '\n');
        } else if (record.type === 'response' && record.id === 'causyne-prompt') {
          if (!record.success) {
            fail(new Error(`Pi rejected the prompt: ${String(record.error || 'unknown error')}`));
            return;
          }
          acknowledged = true;
          if (record.data?.disposition === 'handled') settled = true;
          complete();
        } else if (record.type === 'message_update') {
          const update = record.assistantMessageEvent;
          if (update?.type === 'text_delta' && typeof update.delta === 'string') {
            streamed += update.delta;
            options.onChunk?.(update.delta);
          } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
            options.onReasoningChunk?.(update.delta);
          }
        } else if (record.type === 'tool_execution_start' || record.type === 'tool_execution_end') {
          const id = String(record.toolCallId || '');
          const earlier = nativeActions.get(id);
          const action: ChatResponseAction = {
            id, name: String(record.toolName || earlier?.name || 'pi_tool'),
            parameters: record.args || earlier?.parameters || {},
            status: record.type === 'tool_execution_start' ? 'running' : record.isError ? 'failed' : 'completed'
          };
          nativeActions.set(id, action);
          options.onNativeAction?.(action);
        } else if (record.type === 'message_end' && record.message?.role === 'assistant') {
          const message = record.message;
          finalText = Array.isArray(message.content)
            ? message.content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text || '')).join('')
            : String(message.content || '');
          stopReason = String(message.stopReason || '');
          const data = message.usage || {};
          usage = {
            promptTokens: usage.promptTokens + (Number(data.input) || 0),
            uncachedPromptTokens: (usage.uncachedPromptTokens || 0) + (Number(data.input) || 0),
            completionTokens: usage.completionTokens + (Number(data.output) || 0),
            cachedPromptTokens: (usage.cachedPromptTokens || 0) + (Number(data.cacheRead) || 0),
            measurement: data.input != null && data.output != null ? 'provider_reported' : 'text_estimate',
            cacheMeasurement: data.cacheRead != null ? 'provider_reported' : 'unavailable'
          };
        } else if (record.type === 'agent_settled') {
          if (record.aborted) stopReason = 'aborted';
          settled = true;
          complete();
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try { handle(JSON.parse(line) as Record<string, any>); }
          catch (error) { fail(new Error(`Invalid Pi RPC record: ${String(error)}`)); return; }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', error => fail(new Error(`Pi CLI unavailable: ${error.message}`)));
      child.on('close', code => {
        if (!finished) fail(new Error(`Pi RPC exited before completion (${code ?? 'unknown'})${stderr ? `: ${stderr.slice(-400)}` : ''}`));
      });
      child.stdin.on('error', error => fail(new Error(`Pi RPC input failed: ${error.message}`)));
      child.stdin.write(JSON.stringify({ id: 'causyne-state', type: 'get_state' }) + '\n');
    });
  }
}
