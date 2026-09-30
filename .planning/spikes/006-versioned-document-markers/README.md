---
spike: 006
name: versioned-document-markers
type: standard
validates: "Given a saved unsigned draft, when a test document marker is submitted or retried, then metadata alone is stored against the exact terms version and stale/forged writes fail"
verdict: VALIDATED
related: [002, 003, 004, 005]
tags: [web, sqlite, documents, idempotency]
---

# Spike 006: Versioned metadata-only document markers

The local API may save a category, file kind, user-entered test descriptions
and a **claimed** demo role against one unsigned draft version. It rejects
file-name and file-byte fields, arbitrary status and approval fields. The browser
never uploads selected file contents or its name automatically, but descriptions
are saved as entered; users must not put sensitive information in them. The API
has no route to retrieve a file.
Earlier markers remain associated with earlier terms versions, not with the
current deal by default. A request ID makes exact retries idempotent.

## Evidence

- `node --test web/markers.test.mjs web/server.test.mjs`: input schema,
  unsupported categories, extra/file/payment fields, stale version, duplicate
  request and restart persistence pass.
- Full local suite: 43 Node tests plus 7 offline Solana tests pass.
- Browser at `127.0.0.1:4174`: a fictional veterinary PDF marker appeared on
  v3, survived reload, and moved to the clearly labelled archive after the
  draft advanced to v4. Desktop and 390×844 views remained readable; console
  errors were empty. The selected fixture contained no private information.

## Boundary

This is not private storage, a verified upload, NCA identity, a signed document,
delivery proof or a payment confirmation. The API listens on loopback but has
no user authentication; all entries must be fictitious or anonymized.
The document categories currently exist in both the browser catalog and the
server validator; keep them synchronized if the taxonomy changes.
