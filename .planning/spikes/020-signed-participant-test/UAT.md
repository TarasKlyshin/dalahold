# Personal TEST signed-cabinet UAT — not production

Start the explicit TEST OCSP stand from repository root:

```sh
NCA_SDK_ROOT='/Users/tarasklyshin/Downloads/SDK/SDK/SDK/SDK 2.0' node web/signed-participant-server.mjs
```

Open `http://127.0.0.1:4178/participants/` on the Mac with NCALayer. This uses a
new private database, not4177 or the earlier4175 personal registry. No passwords,
private containers, real IIN/BIN or documents go into the chat/Git.

1. Create a TEST participant and privately save its one-time bearer code.
   The code opens this local account; the certificate does not provide login.
2. Inspect the exact TEST enrollment instruction, consent, then sign in the
   NCALayer dialog using an eligible personal TEST signing certificate.
   Verify one durable binding/receipt, not a production identity or authority.
3. Explicit same-CMS retry must say historical; no second binding/verification.
   A second account using that same person must refuse, even with a new CMS.
4. For real two-party UAT, another participant needs a valid personal TEST
   certificate of a DIFFERENT identity. Create/invite that participant, bind
   their certificate, review the same anonymous conditions and file manifest.
5. Seller signs offer; buyer signs agreement; seller signs handover; buyer signs
   acceptance OR either signs dispute. Each opens a new exact instruction and
   requires a fresh signature. No payment follows. Changed state or files must
   invalidate outstanding CMS; direct unsigned event must refuse.
6. Close/expire session during signing. No late write can commit; visible
   instruction/CMS/credentials clear. A committed earlier event is not undone.
7. After restart, bearer login returns the same certificate binding and deal.
   Receipt/event export must contain no CMS, session, mapping key or person ID.

The missing SAME-person second eligible certificate is a DIFFERENT requirement:
it is for genuine renewal in Spike017, not the second counterparty. This stand
pins certificate/epoch0 and refuses automatic rebind. Full technical-prototype
acceptance requires both tests, not one certificate selected twice.

Clarification from the current SDK pair: `valid` and `revoked` belong to the
same test person. A revoked old credential need not become good again for
replacement, provided its historical binding was genuinely accepted before
revocation and the new credential passes fresh verification. Our retained
registry instead binds the currently good `valid` digest. No historical revoked
binding is fabricated; its actual rejection and genuine positive renewal remain
different tests. This pair cannot serve as two independent counterparties.

Memo is separately disabled unless the operator configures a stable devnet
fee-payer address. Its signed operation preview must explicitly say devnet,
fixed Memo program and fee ceiling; it is not a payment or permission inferred
from agreement. The signing cabinet has no broadcast or raw-wire endpoint.

Browser automation was previously denied. The human now authorized a retry,
but the service still refused because its mandatory admin-policy check was
unavailable. Do not bypass that check with an alternate transport or port.
Manual feedback, authorized browser interaction, genuine SDK checks and model
tests must be recorded separately.
