# Personal TEST signed participant API v1

This is the separate loopback4178 stand, not an upgrade of the unsigned4177
database. Base `/api/participants/v1`; scope is
`local_personal_test_signed_deal_only`. The session, participant, membership,
invitation, version and private document contracts from [019](../019-participant-test-cabinet/API.md)
still apply, with the following signed-only differences. Anonymous legacy draft,
personal-registry, grants, broadcast and raw-wire routes do not exist.

## Sessions and private binding

`GET /session` includes `signing:{enabled:true,statusSource:"test_ocsp"}`.
Bearer code login remains local pseudonymous account access, not certificate
login. Every signing resource requires that authenticated server account.
Every POST requires the same Origin, HttpOnly session cookie and CSRF value.

- `GET /signing`: trusted SDK readiness, two public TEST chain certificates,
  fresh `validUntil`, `statusSource:"test_ocsp"`, scope and `anchorEnabled`.
  SDK/status errors return503; no automatic CRL/OCSP fallback is performed.
- `GET /identity`: `{binding,scope}`; binding is null or only
  `{bindingId,certificateDigest,authEpoch:0,scope}`. No person/organization ID,
  subject, IIN/BIN, HMAC key, CMS, wallet key or corporate powers are returned.
- `POST /identity-intents {}`: explicit personal TEST enrollment intention.
  One verified personal identity/certificate cannot occupy two local accounts.
  Corporate certificates are refused. A changed certificate requires a
  separately accepted renewal path; this stand has no automatic rebind.

## Exact intentions and CMS receipts

- `POST /deals/:id/signature-intents`
  `{requestId,action,expectedVersion,expectedStateRevision,snapshotHash}`:
  actions `offer`, `agree`, `handover`, `accept` or `dispute`, using the same
  membership/role/order policy as019. Both distinct personal TEST bindings are
  required. Intent pins the complete canonical terms, current document manifest,
  both bindings, certificate digests, epoch, actor role and state revision.
- `POST /deals/:id/anchor-intents`
  `{expectedVersion,expectedStateRevision,snapshotHash}`: only a terminal
  accepted signed deal, and only when a fixed operator wallet/fee configuration
  is provided. The server generates its request ID and `anchor_test_memo`
  action. Browser cannot choose wallet, program, memo, chain or fee. This is an
  additional intention, never a permission inferred from agreement/acceptance.
- Both issue routes return201 `{intent,scope}`. Public intent is exactly
  `{id,text,bytesBase64,hash,expiresAt}`; expiry is issuedAt+5minutes. `text` and
  base64 decode to the same exact canonical UTF-8 bytes including the final LF.
  The browser validates their SHA-256 and current context before NCALayer.
- `POST /signature-receipts {intentId,cms}`: exact canonical base64 detached
  CMS, up to98304 decoded bytes. Actor/session-bound intention is loaded from
  private server storage. Client intent bytes, identity, role or SDK result are
  not accepted. Session, deadline, status, binding, role, state and full snapshot
  are checked again at the atomic event/receipt commit.

Success200 is `{receipt,historical,scope}` plus `event`/current `deal` where
applicable. Receipt contains only IDs, hashes, action, binding/epoch,
certificate digest, times, status source and TEST scope. A fresh receipt advances
one event; same actor/session/intent/exact CMS returns the saved receipt with
`historical:true`, without another SDK status check or business effect. It is
not fresh permission. A lost response must retry the identical request, not
create a new intention or call NCALayer again.

`POST /deals/:id/events` is always403 `signature_required` on this stand.
Unsigned statements cannot become signed permissions or be migrated here.
Signed event source is `personal_test_nca_statement`, with protected receipt
metadata under `authorization`. Mutation of pending/accepted bytes, event or
binding evidence fails closed. Neither signatures nor document hashes verify
physical delivery or the truth of an uploaded text.

## Refusals and bounds

Errors are `{error:{code,message}}`, with no SDK subject/key diagnostics.
Typical statuses:400 malformed exact fields/encoding;401 closed/expired session;
403 wrong role/unsigned operation;404 foreign account/deal/intention;
409 stale snapshot/state/binding, duplicate person/certificate or conflicting
replay;413 bounded intention/history/CMS storage;429 rate limit;503 verifier
unavailable/busy/status outage. No rejection commits an event or receipt.

In addition to019 quotas:100 pending intentions,500 accepted receipts,
16MiB accepted private CMS bytes,2 shared verifier slots. Private signed SQLite
uses DELETE/FULL/mmap0 and owner-only directory/file modes. Keyed binding-set
and row MACs detect bounded edits/deletion, not an operator with the key or a
whole-machine rollback. No wallet seed is derived from an NCA key.

## Still closed

This API supplies no production identity/login, corporate authority, legal
contract, real money, digital tenge, certificate-renewal acceptance or live
devnet execution. Signed anchor evidence is consumed only by an internal,
default-disabled library; no HTTP grant/broadcast/wire export exists. Genuine
two-person signing, same-person replacement and authorized browser UAT remain
separate acceptance gates.
