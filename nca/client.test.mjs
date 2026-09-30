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
  for (const cancellation of [{ status: false }, { status: true, body: {} }]) {
    pending = ncalayerCall({}, { WebSocketClass: Socket, timeout: 100 });
    await Promise.resolve();
    Socket.last.onmessage({ data: JSON.stringify(cancellation) });
    await assert.rejects(pending, /signing_cancelled_or_rejected/);
    assert.equal(Socket.last.closed, true);
  }
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

test('Basics EmptyResponse is cancellation, not a signature or unsupported success payload', () => {
  // Installed Basics returns EmptyResponse on dialog dismissal. CommonInvoker
  // wraps a normal method return as status:true, body:{}, not status:false.
  assert.throws(() => signatureFromResponse({ status: true, body: {} }),
    /signing_cancelled_or_rejected/);
  for (const body of [null, [], { result: null }, { result: '' }, { other: 'claim' }]) {
    assert.throws(() => signatureFromResponse({ status: true, body }), /invalid_ncalayer_response/);
  }
});

test('NCALayer CMS PEM becomes canonical base64 without changing the signature bytes', () => {
  const bytes = Buffer.from([0x30, 0x81, 0x80, ...Array.from({ length: 128 }, (_, i) => i)]);
  const base64 = bytes.toString('base64');
  for (const newline of ['\n', '\r\n']) {
    const pem = `-----BEGIN CMS-----${newline}${base64.match(/.{1,64}/g).join(newline)}` +
      `${newline}-----END CMS-----${newline}`;
    for (const result of [pem, [pem], { signatures: [pem] }]) {
      const normalized = signatureFromResponse({ status: true, body: { result } });
      assert.equal(normalized, base64);
      assert.deepEqual(Buffer.from(normalized, 'base64'), bytes);
    }
  }
  assert.equal(signatureFromResponse({ status: true, body: { result: base64 } }), base64);
});

test('CMS transport rejects ambiguous PEM, noncanonical base64 and oversized containers', () => {
  const pem = '-----BEGIN CMS-----\nY21z\n-----END CMS-----\n';
  for (const result of [pem + pem, 'prefix' + pem, pem + 'trailer',
    pem.replace('END CMS', 'END CERTIFICATE'), pem.replaceAll('CMS', 'CERTIFICATE'),
    pem.replace('Y21z', ''), pem.replace('Y21z', 'AB=='), pem.replace('Y21z', 'Y21z!'),
    'AB==', 'Y21z\n', 'Y21z ', '____', 'A'.repeat(131_076)]) {
    assert.throws(() => signatureFromResponse({ status: true, body: { result } }),
      /invalid_ncalayer_response/);
  }
});

test('timed-out socket cannot issue a late signing request; oversized responses refuse', async () => {
  class Socket {
    constructor() { Socket.last = this; }
    close() { this.closed = true; }
    send(value) { this.sent = value; }
  }
  const expired = ncalayerCall({ method: 'sign' }, { WebSocketClass: Socket, timeout: 5 });
  const late = Socket.last;
  await assert.rejects(expired, /ncalayer_timeout/);
  late.onopen();
  assert.equal(late.sent, undefined, 'a timed-out operation issued a signing request');
  const oversized = ncalayerCall({ method: 'sign' }, { WebSocketClass: Socket, timeout: 100 });
  const socket = Socket.last;
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ status: true, body: { result: 'Y21z' },
    padding: 'x'.repeat(160_001) }) });
  await assert.rejects(oversized, /invalid_ncalayer_response/);
  assert.equal(socket.closed, true);
});
