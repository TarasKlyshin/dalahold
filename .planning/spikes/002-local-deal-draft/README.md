---
spike: 002
name: local-deal-draft
type: standard
validates: "Given the desktop web cabinet and local API, when a draft is created and the page or server restarts, then exact unsigned terms remain selectable while forged or malformed writes are rejected"
verdict: VALIDATED
related: [001]
tags: [web, sqlite, draft, integration]
---

# Spike 002: Local deal draft integration

## What This Validates

The existing browser cabinet can save and reopen an **unsigned** agricultural draft through a loopback-only API. It does not validate NCA EDS, participant identity, document storage, settlement, or Solana broadcast.

## Research

| Approach | Benefit | Limit | Decision |
|---|---|---|---|
| Browser `localStorage` | Fewest lines | Does not prove browser-to-API or server persistence | Rejected for this question |
| Existing `DealFlow` fixture | Reuses persisted exact order | Its trusted fixture import requires a verified owner and Solana recipient; exposing it as an unauthenticated web create route would cross the trust boundary | Rejected for unsigned drafts |
| Node 22 `node:http` + built-in SQLite | Matches existing runtime; durable drafts without dependencies | Local test-mode endpoint only, no participant authentication | Chosen |

The integration must not turn the role switch into an authorization mechanism. The existing prototype remains a demo; only draft terms are persisted in this slice.

## How to Run

`node web/server.mjs` from the repository root, then open <http://127.0.0.1:4174/>. API checks: `node --test web/server.test.mjs`.

## What to Expect

Create a draft, reload the page, and select the same terms. Browser-only steps and file labels remain explicitly transient. A request from an untrusted browser origin or one with malformed terms must fail.

## Investigation Trail

- 2026-09-27: selected a draft-only vertical slice because the current `DealFlow` import is explicitly trusted-fixture-only and the NCA verifier is unavailable. The existing UX prototype must not silently claim signed state.
- 2026-09-27: a Node HTTP/SQLite service saves exact validated draft fields and serves the existing UI on loopback. The browser shows a distinct saved-draft picker and labels the route steps, file labels and roles as simulations.
- 2026-09-27: malformed, overlarge, cross-origin and wrong-content-type writes were checked. The browser rejected invalid quantity, saved a valid test draft, and restored its exact quantity and amount after reload. UI accessibility state showed «СОХРАНЁН БЕЗ ЭЦП» and test-profile parties.

## Results

**VALIDATED for this narrow question:** 2/2 API tests and 34/34 repository tests passed on Node 22.22.2. An actual browser created and restored an unsigned test draft after reload; the API test restored it after a server restart. The API does not accept arbitrary fields such as a client-supplied recipient, and it rejects a foreign Origin. The UI clearly distinguishes saved terms from signatures and payments.

**Not validated:** multi-user identity, document persistence, authenticated approvals, NCA EDS, Solana devnet or production security. This local API must remain loopback-only. Browser visual inspection was at the available desktop viewport; an explicit mobile viewport override was unavailable in the browser tooling, so responsive behavior needs a later device-width check.
