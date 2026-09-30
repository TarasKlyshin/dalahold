import assert from 'node:assert/strict';
import test from 'node:test';
import { ncalayerCall, signatureFromResponse, signingRequest } from './client.mjs';

test('NCALayer request preserves exact server base64 and uses an explicit nonempty test chain', () => {
  const chain = ['-----BEGIN CERTIFICATE-----A', '-----BEGIN CERTIFICATE-----B'];
  const request = signingRequest({ bytesBase64: 'ZXhhY3Q=' }, chain);
  assert.equal(request.args.data, 'ZXhhY3Q=');
  assert.deepEqual(request.args.signingParams, { decode: true, encapsulate: false, digested: false });
  assert.deepEqual(request.args.signerParams.chain, chain);
  assert.throws(() => signingRequest({ bytesBase64: 'x' }, []));
  assert.throws(() => signingRequest({}, chain));
  for (const result of ['Y21z', ['Y21z'], { signatures: ['Y21z'], certificate: 'untrusted claim' }]) {
    assert.equal(signatureFromResponse({ status: true, body: { result } }), 'Y21z');
  }
  for (const result of [null, '', ['one', 'two'], { signatures: [] }]) {
    assert.throws(() => signatureFromResponse({ status: true, body: { result } }));
  }
  assert.throws(() => signatureFromResponse({ status: false, code: 'secret error' }), /signing_cancelled_or_rejected/);
});

test('one socket ignores the greeting, closes after signing, and rejects cancel/disconnect/timeout', async () => {
  class Socket {
    constructor() { Socket.last = this; queueMicrotask(() => this.onopen()); }
    close() { this.closed = true; this.onclose?.(); }
    send(value) { this.sent = JSON.parse(value); }
  }
  let pending = ncalayerCall({ method: 'sign' }, { WebSocketClass: Socket, timeout: 100 });
  await Promise.resolve();
  const socket = Socket.last;
  socket.onmessage({ data: JSON.stringify({ result: { version: '1.4' } }) });
  socket.onmessage({ data: JSON.stringify({ status: true, body: { result: 'Y21z' } }) });
  assert.equal(await pending, 'Y21z');
  assert.equal(socket.closed, true);
  pending = ncalayerCall({}, { WebSocketClass: Socket, timeout: 100 });
  await Promise.resolve();
  Socket.last.onmessage({ data: JSON.stringify({ status: false }) });
  await assert.rejects(pending, /signing_cancelled_or_rejected/);
  pending = ncalayerCall({}, { WebSocketClass: Socket, timeout: 100 });
  await Promise.resolve();
  Socket.last.onclose();
  await assert.rejects(pending, /ncalayer_disconnected/);
  await assert.rejects(ncalayerCall({}, { WebSocketClass: Socket, timeout: 5 }), /ncalayer_timeout/);
  pending = ncalayerCall({}, { WebSocketClass: Socket, timeout: 100 });
  await Promise.resolve();
  Socket.last.onerror();
  await assert.rejects(pending, /ncalayer_unavailable/);
  assert.equal(await ncalayerCall(null, { WebSocketClass: Socket }), true);
});
