import test from 'node:test';
import assert from 'node:assert/strict';
import { isJsonRpcRequest, isJsonRpcResponse, isJsonRpcNotification } from '../src/acp/protocol.js';

const request = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} };
const response = { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } };
const notification = { jsonrpc: '2.0', method: 'session/update', params: {} };
const error = { code: -32603, message: 'Internal error' };
function classify(value) {
  return [isJsonRpcRequest(value), isJsonRpcResponse(value), isJsonRpcNotification(value)];
}

test('valid request, response and notification shapes are mutually exclusive', () => {
  assert.deepEqual(classify(request), [true, false, false]);
  assert.deepEqual(classify(response), [false, true, false]);
  assert.deepEqual(classify(notification), [false, false, true]);
});
