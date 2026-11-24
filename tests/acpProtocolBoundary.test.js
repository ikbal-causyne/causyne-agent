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

test("request with result cannot impersonate a completed RPC", () => {
  assert.deepEqual(classify({ ...request, result: {} }), [false, false, false]);
});

test("request with error cannot impersonate a failed RPC", () => {
  assert.deepEqual(classify({ ...request, error }), [false, false, false]);
});

test("notification containing result is not dispatched as a session update", () => {
  assert.deepEqual(classify({ ...notification, result: {} }), [false, false, false]);
});

test("notification containing error is not dispatched as a session update", () => {
  assert.deepEqual(classify({ ...notification, error }), [false, false, false]);
});

test("response cannot contain both result and error", () => {
  assert.deepEqual(classify({ ...response, error }), [false, false, false]);
});

test("error response with null identifier remains valid JSON-RPC", () => {
  assert.deepEqual(classify({ jsonrpc: '2.0', id: null, error }), [false, true, false]);
});
