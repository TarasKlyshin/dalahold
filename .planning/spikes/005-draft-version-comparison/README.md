---
spike: 005
name: draft-version-comparison
type: standard
validates: "Given at least two unsigned versions, when a user opens the current draft, then changed terms are explicit and an unchanged resubmission creates no false new version"
verdict: VALIDATED
related: [003, 004]
tags: [web, ux, versions, comparison]
---

# Spike 005: Compare unsigned versions

The cabinet shows which of four stored terms changed relative to the previous
version: scenario, quantity (with the correct unit), amount and delivery date.
The server still owns version history; the browser only renders a comparison.
An unchanged edit remains the current version and now has an accurate message.

## Evidence

- Browser: v3 showed `20 голов → 21 голова` relative to v2, while the hash
  remained clearly marked as unsigned. Reopening the edit form and submitting
  identical values left the version at v3 with an explicit no-change message.
- At 390×844, the comparison and complete SHA-256 value fit inside the deal
  card without horizontal clipping. Browser console reported no errors.
- API tests cover idempotent unchanged submission and persisted history.

## Boundary

Comparison is local, unauthenticated and unsigned. It does not establish an
agreement between real buyer and seller or verify physical delivery.
