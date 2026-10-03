// Opt-in genuine bundled SDK certificates, isolated signed HTTP cabinet only.
// One eligible personal identity proves enrollment and negative cases, NOT a
// two-person approval, certificate renewal or real NCALayer/manual acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { prepareSdk, javaProcess } from './sdk.mjs';
import { startSignedParticipantWorkspace } from '../web/signed-participant-server.mjs';

const API = '/api/participants/v1';
async function fixturePassword(root) {
  try {
    const bytes = await readFile(join(root, 'Keys and Certs/Gost2015/README.txt'));
    const utf8 = bytes.toString('utf8');
    const text = utf8.includes('\ufffd') ? new TextDecoder('windows-1251').decode(bytes) : utf8;
    const value = /Пароль к тестовым сертификатам:\s*(\S+)/u.exec(text)?.[1];
    if (!value) throw new Error();
    return value;
  } catch { throw new Error('bundled_fixture_password_unavailable'); }
}

test('genuine personal TEST CMS through isolated participant enrollment and negative HTTP gates',
  { skip: !process.env.NCA_SDK_ROOT, timeout: 180000 }, async t => {
    const root = process.env.NCA_SDK_ROOT;
    const java = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';
    const directory = await mkdtemp(join(tmpdir(), 'dalahold-participant-sdk-'));
    let sdk, stand;
    t.after(async () => { await stand?.close(); await sdk?.close(); await rm(directory, { recursive: true, force: true }); });
    const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar', 'Java/utils/knca_provider_util-0.8.5.jar']
      .map(path => join(root, path)).join(delimiter);
    await javaProcess(join(java, 'javac'), ['-encoding', 'UTF-8', '-d', directory, '-cp', jars,
      ...['CmsVerifier.java', 'OcspVerifier.java', 'TestCmsSigner.java']
        .map(path => fileURLToPath(new URL(path, import.meta.url)))]);
    const password = await fixturePassword(root);
    const sign = async (intent, mode = 'sign') => {
      const output = (await javaProcess(join(java, 'java'), ['-cp', [directory, jars].join(delimiter),
        'TestCmsSigner', root, mode, join(root, 'Keys and Certs/CRL')], `${password}\n${intent.bytesBase64}\n`)).trim();
      assert.ok(!output.startsWith('{') && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output),
        'genuine bundled fixture must return detached TEST CMS without diagnostics');
      return output;
    };
    sdk = await prepareSdk({ sdkRoot: root, javaBin: java, statusSource: 'ocsp' });
    let calls = 0, unavailable = false;
    const trusted = { statusSource: sdk.statusSource, inspect: () => sdk.inspect(),
      async verifyIdentity(bytes, cms, key) {
        calls++; if (unavailable) throw new Error('verifier_unavailable');
        return sdk.verifyIdentity(bytes, cms, key);
      } };
    stand = await startSignedParticipantWorkspace({ directory: join(directory, 'private-cabinet'), port: 0, sdk: trusted });
    const origin = new URL(stand.url).origin;
    const client = () => {
      let cookie = '', csrf = '';
      return {
        async request(path, body) {
          const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
              Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          const header = response.headers.get('set-cookie'); if (header) cookie = header.split(';')[0];
          const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
          return { status: response.status, data };
        },
        async register() {
          await this.request(API + '/session');
          assert.equal((await this.request(API + '/participants', {})).status, 201);
        },
        async issue() {
          const result = await this.request(API + '/identity-intents', {}); assert.equal(result.status, 201);
          const intent = result.data.intent;
          assert.equal(Buffer.from(intent.bytesBase64, 'base64').toString('utf8'), intent.text);
          assert.equal(JSON.parse(intent.text).domain, 'dalahold:participant-personal-test-signatures:v1');
          return intent;
        },
        submit(intent, cms) { return this.request(API + '/signature-receipts', { intentId: intent.id, cms }); },
      };
    };
    const a = client(), b = client(); await a.register(); await b.register();
    const status = await a.request(API + '/signing'); assert.equal(status.status, 200);
    assert.equal(status.data.ready, true); assert.equal(status.data.statusSource, 'test_ocsp');
    assert.equal(status.data.anchorEnabled, false);
    const first = await a.issue(), cms = await sign(first);
    const enrolled = await a.submit(first, cms); assert.equal(enrolled.status, 200);
    assert.equal(enrolled.data.historical, false); assert.equal(enrolled.data.receipt.action, 'enroll_test_participant');
    assert.equal(enrolled.data.receipt.scope, 'local_personal_test_signed_deal_only');
    const acceptedCalls = calls;
    const historical = await a.submit(first, cms); assert.equal(historical.status, 200);
    assert.equal(historical.data.historical, true); assert.deepEqual(historical.data.receipt, enrolled.data.receipt);
    assert.equal(calls, acceptedCalls, 'exact replay never performs a new certificate status check');

    const other = await b.issue();
    const duplicate = await b.submit(other, await sign(other));
    assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error.code, 'signature_person_already_bound');
    assert.equal((await b.request(API + '/identity')).data.binding, null);
    for (const mode of ['legal-signer', 'revoked', 'wrong-purpose']) {
      const intent = await b.issue();
      const result = await b.submit(intent, await sign(intent, mode));
      assert.notEqual(result.status, 200, 'corporate, revoked and wrong-purpose TEST certificates must refuse');
      assert.equal((await b.request(API + '/identity')).data.binding, null);
    }
    const changed = await b.issue();
    const tampered = { ...changed, bytesBase64: Buffer.from('TEST altered instruction').toString('base64') };
    assert.notEqual((await b.submit(changed, await sign(tampered))).status, 200);
    assert.equal((await b.request(API + '/identity')).data.binding, null);
    unavailable = true;
    const notReady = await b.issue();
    assert.equal((await b.submit(notReady, await sign(notReady))).status, 503);
    unavailable = false;
    const closing = await b.issue(), beforeClose = calls;
    assert.equal((await b.request(API + '/session/logout', {})).status, 200);
    assert.equal((await b.submit(closing, await sign(closing))).status, 401);
    assert.equal(calls, beforeClose, 'closed session never reaches SDK verification');

    const db = new DatabaseSync(join(directory, 'private-cabinet', 'participants.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('SELECT count(*) AS n FROM participant_signature_bindings').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM participant_signature_intents WHERE receipt_json IS NOT NULL').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM participant_events').get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='personal_bindings'").get().n, 0);
    } finally { db.close(); }
    assert.doesNotMatch(JSON.stringify(enrolled.data), /personId|organizationId|mappingKeyId|sessionHash|\"cms\"|\"grant\"|wireBytes/);
  });
