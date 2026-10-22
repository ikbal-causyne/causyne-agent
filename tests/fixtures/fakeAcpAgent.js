// Minimal ACP agent used by the peer delegation tests. It speaks just enough
// of the protocol to exercise the client: initialize, session/new,
// session/prompt with a permission round-trip, and session/cancel.
let buffer = '';
let pendingPrompt = null;
let serverRequestId = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'Fake Peer', version: '1.0.0' }
      }
    });
    return;
  }

  if (message.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: message.id, result: { success: true } });
    return;
  }

  if (message.method === 'session/new') {
    if (process.env.SIMULATE_AUTH_ERROR === '1') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'Authentication required: run fake-agent login' }
      });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
    return;
  }

  if (message.method === 'session/set_model' || message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: { success: true } });
    return;
  }

  if (message.method === 'session/prompt') {
    const sessionId = message.params.sessionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'peer says hello' } }
      }
    });
    pendingPrompt = { id: message.id, sessionId };
    send({
      jsonrpc: '2.0',
      id: `fixture-${serverRequestId++}`,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'fixture-call', title: 'write file', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
      }
    });
    return;
  }

  if (message.method === 'session/cancel') {
    if (pendingPrompt) {
      send({
        jsonrpc: '2.0',
        id: pendingPrompt.id,
        result: { stopReason: 'cancelled' }
      });
      pendingPrompt = null;
    }
    return;
  }

  if (pendingPrompt && 'id' in message && ('result' in message || 'error' in message)) {
    const approved = message.result?.outcome?.outcome === 'selected'
      && message.result.outcome.optionId === 'allow';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: pendingPrompt.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: approved ? ' approved' : ' rejected' }
        }
      }
    });
    send({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'end_turn' } });
    pendingPrompt = null;
    return;
  }

  if ('id' in message && message.method) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `unsupported: ${message.method}` }
    });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf('\n');
  }
});
