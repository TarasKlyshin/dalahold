# Local participant API v1

Base `/api/participants/v1`, only exact loopback Host/Origin. No external access.
Flat success JSON; errors `{error:{code,message}}` with meaningful HTTP status.
Only listed resources exist; `/api/deals`, 018 APIs and personal/NCA pages refuse.
No query-string credentials. Responses `no-store`; no raw credentials in exports.

## Session and participant

`GET /session` opens a 15-minute anonymous CSRF bootstrap if no valid session
exists. It returns `authenticated`, `csrfToken`, `expiresAt`, `scope`, and an
opaque participant when logged in. It never automatically authenticates.
Every POST requires matching Origin and `X-DalaHold-CSRF`, JSON object with the
exact documented fields, <=370000 body bytes and a 15-second body deadline.

- `POST /participants {}`: create one pseudonymous TEST participant; return one
  random256-bit `accessCode`, participant and rotated authenticated session.
  The database stores only its SHA-256 hash. Save the code privately; no reset,
  real identity recovery or NCA linking is implemented. Registration response
  loss can leave an unreachable TEST account; do not assume a safe new signup.
- `POST /session/login {accessCode}`: authenticate an existing local TEST account,
  rotate session/CSRF. Already authenticated sessions cannot change participant.
- `POST /session/logout {}`: invalidate this server session and expire its cookie.
  Logout/expiry never undo previously committed statements/documents.

Cookies: HttpOnly, SameSite=Strict, path limited to this API. Sessions are memory
only and do not survive restart. Local HTTP is not production secure transport.
Registration and login are globally rate-capped; participant/request/document
quotas bound durable state. Status code429 includes Retry-After.

## Private deals, invitations and versions

All following resources require an authenticated server participant. No client
actor/role field can override an existing membership. Outsider detail/history,
download/upload/event routes return404 before revealing deal contents.

- `GET /deals`: only the participant's deals, bounded to100 memberships.
- `POST /deals {requestId,creatorRole,scenario,quantity,amount,date}`: create a
  new TEST deal; creator chooses their role for this new deal only. UUID requestId,
  seller/buyer role, grain/livestock scenario, positive bounded integers and
  valid ISO calendar date are required. Amount is demo KZT, no payment rail.
- `GET /deals/:id`: current exact terms, role, members, current documents,
  prior document metadata, statement events, snapshotHash and explicit TEST scope.
- `POST /deals/:id/invitations {expectedVersion,participantId}`: creator in a
  one-member draft invites the specified registered other TEST participant.
  Opposite role is server-derived. The random code is returned once and stored
  only as a hash; a newly issued code revokes the previous pending invitation.
- `POST /invitations/claims {code}`: only the named recipient may claim; same
  recipient's exact accepted-token retry is historical. Pending code expires
  in15minutes. Possession alone gives no outsider membership.
- `POST /deals/:id/versions {requestId,expectedVersion,scenario,quantity,amount,date}`:
  only a seller in draft can revise. Exact actor-bound retry is historical.
  Once offered, amendment is closed; create a new TEST deal for new terms.

## Documents and statements

- `POST /deals/:id/documents {requestId,expectedVersion,category,contentBase64}`:
  draft members may save anonymized UTF-8 text1..262144bytes, max10/version;
  contract/delivery/quality/other category. No original filename is uploaded.
  `GET /deals/:id/documents` lists current metadata; `GET /deals/:id/documents/:id`
  downloads validated bytes with a generated attachment name. Historical member
  access is permitted; outsider access is not. Global8MiB/1024-file quota applies.
- `POST /deals/:id/events {requestId,action,expectedVersion,expectedStateRevision,snapshotHash}`:
  exact canonical terms, manifest and parties must match. Snapshot is frozen
  at offer. Seller `offer`, buyer `agree`, seller `handover`, buyer `accept`;
  either party `dispute` after agreement or handover. Accepted/disputed are
  terminal. There is no reserve, release, wallet or payment operation.

New events201; exact replay200 `historical:true` with the same event. Changed
payload/actor with the same requestId, stale version/state/hash, wrong role and
out-of-order actions refuse without a second event. Source is always
`unsigned_test_participant_statement`. Concurrent accept/dispute yields one
successful transition and one conflict. Session validity is rechecked at commit.

## Open gates

This API has no NCA-authenticated users, powers, signed contract, true two-person
identity test, certificate replacement, government resource, bank confirmation,
production storage/audit or Solana devnet execution. Anonymized TEST only.
