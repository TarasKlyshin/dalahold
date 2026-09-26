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

This is not the whole signer. Its caller must still enforce durable replay,
current authority epoch, the exact deal order and blockhash freshness. The
offline 5,000-lamport fee check is a local policy floor for a single-signature
test transfer, not a live network fee quote. Never derive a Solana key from an
NCA certificate or store a personal key, password, IIN/BIN or real funds here.

Run `npm ci --ignore-scripts` and `npm test` in this directory. Tests generate
throwaway Ed25519 keys and verify the decoded wire transaction without sending.
