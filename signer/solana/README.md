# Offline Solana transaction builder

`buildOfflineTransfer` accepts a policy-signed DalaHold test-transfer envelope,
an ephemeral 32-byte Ed25519 Solana private key in memory, and a caller-supplied
recent blockhash/lifetime. It verifies the policy signature and exact grant
fields, requires the derived wallet address to match the grant, and signs a
single version-0 System Program SOL transfer capped at 1,000,000 lamports. It
returns real serialized transaction bytes and a signature. It has **no RPC,
airdrop or broadcast path**.

The policy public key must come from the signer's trusted local configuration,
never from a browser request. A browser must not be able to call this builder
or supply its Solana signing key.

`Signer.prepareOfflineTransfer` now supplies the policy key from local config,
checks the current epoch and wallet binding, and caches one signed transaction
per grant/order in SQLite. This method is internal only: no HTTP route exposes
the bytes. The issuer must still enforce the exact deal order, and a future
network adapter must verify blockhash freshness. The
offline 5,000-lamport fee check is a local policy floor for a single-signature
test transfer, not a live network fee quote. Never derive a Solana key from an
NCA certificate or store a personal key, password, IIN/BIN or real funds here.

Once signed bytes have left the trusted process, a certificate rotation cannot
cryptographically revoke them before their blockhash expires. Do not hand these
bytes to a browser; a real sender must keep them private and reconcile the
network outcome.

Run `npm ci --ignore-scripts` and `npm test` in this directory. Tests generate
throwaway Ed25519 keys and verify the decoded wire transaction without sending.
