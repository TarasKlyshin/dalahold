# Human TEST cabinet checklist

Open `http://127.0.0.1:4177/participants/` on this Mac. This is not the NCALayer
page or a publicly reachable two-computer service. No real personal information.

1. Register a TEST participant; save the one-time code privately. The input is
   masked until deliberately revealed. Do not send the access code to a party.
2. Create a grain/livestock TEST draft with your role. The demo amount is not
   money. One account can create another deal with the other role.
3. The second participant registers first, saves their own access code, and
   gives you only their opaque participant ID. Use that ID for an invitation.
4. Recipient logs in to their own local TEST account and claims the invitation.
   A third account with the same invitation code must not receive access.
   For agent verification on one browser, logout/login sequentially is enough;
   it is not evidence of independent real people or a remote deployment.
5. In draft, consent to save one anonymous UTF-8 `.txt`, then download and
   compare SHA-256. No original filename is retained. Outsider must not see the
   deal or download by guessed/known IDs. Revisions preserve historical files.
6. Seller inspects exact terms, manifest and snapshot; records TEST offer.
   After that no participant can change those terms/documents in this deal.
7. Buyer checks exactly the same snapshot and records TEST agreement; seller
   records handover; buyer records acceptance OR either party records dispute.
   No reserve, release or payment step follows either terminal state.
8. Export the journal JSON. It names unsigned TEST statement sources; it must
   not include access/invitation codes, cookie/CSRF or original file contents.
9. Expire/logout and confirm visible account, deal, code and actions clear.
   New login with the saved access code returns the same memberships after
   restart. Expiry/closure never undo previously saved events.

If a statement/document/version response is lost, do not create a replacement:
use only the explicit same-payload/request-ID retry. Registration has no safe
recovery of a lost one-time access code. Invitation reissue rotates the code;
it is not an historical event replay. These limitations are explicit TEST-only
ceilings, not a production account-recovery policy.

Record manual feedback separately from agent browser/HTTP tests. This checklist
does not close genuine NCA two-party signatures, corporate powers, same-person
certificate renewal, physical delivery or money/devnet acceptance.
