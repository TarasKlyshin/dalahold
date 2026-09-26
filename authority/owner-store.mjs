import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

function validId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

// Internal state boundary only. Callers must verify NCA identity and powers before
// invoking registerVerifiedOwner or rotateVerifiedCertificate.
export class OwnerStore {
  #db;

  constructor(path) {
    if (typeof path !== 'string' || !path) throw new Error('database path required');
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS owners (
        owner_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        certificate_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL UNIQUE,
        auth_epoch INTEGER NOT NULL CHECK (auth_epoch >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS used_nonces (
        owner_id TEXT NOT NULL REFERENCES owners(owner_id),
        nonce TEXT NOT NULL,
        PRIMARY KEY (owner_id, nonce)
      ) STRICT;
    `);
  }

  close() { this.#db.close(); }

  owner(ownerId) {
    validId(ownerId, 'owner id');
    const row = this.#db.prepare('SELECT * FROM owners WHERE owner_id = ?').get(ownerId);
    return row && {
      ownerId: row.owner_id,
      subjectId: row.subject_id,
      certificateId: row.certificate_id,
      walletAddress: row.wallet_address,
      authEpoch: row.auth_epoch,
    };
  }

  // Trusted internal call; not a self-service registration endpoint.
  registerVerifiedOwner({ ownerId, subjectId, certificateId, walletAddress }) {
    [
      [ownerId, 'owner id'], [subjectId, 'subject id'],
      [certificateId, 'certificate id'], [walletAddress, 'wallet address'],
    ].forEach(([value, name]) => validId(value, name));
    this.#db.prepare(`INSERT INTO owners
      (owner_id, subject_id, certificate_id, wallet_address, auth_epoch)
      VALUES (?, ?, ?, ?, 0)`).run(ownerId, subjectId, certificateId, walletAddress);
    return this.owner(ownerId);
  }

  // False means the nonce was already consumed. The unique constraint is the
  // replay guard, including after process restart and across DB connections.
  consumeNonce(ownerId, nonce) {
    validId(ownerId, 'owner id');
    validId(nonce, 'nonce');
    if (!this.owner(ownerId)) throw new Error('unknown owner');
    return this.#db.prepare(`INSERT OR IGNORE INTO used_nonces (owner_id, nonce)
      VALUES (?, ?)`).run(ownerId, nonce).changes === 1;
  }

  // Certificate replacement is compare-and-swap on the current credential.
  // The verified subject is supplied by the NCA verifier, never by the browser.
  rotateVerifiedCertificate({ ownerId, subjectId, previousCertificateId,
    newCertificateId, nonce }) {
    [
      [ownerId, 'owner id'], [subjectId, 'subject id'],
      [previousCertificateId, 'previous certificate id'],
      [newCertificateId, 'new certificate id'], [nonce, 'nonce'],
    ].forEach(([value, name]) => validId(value, name));
    if (previousCertificateId === newCertificateId) throw new Error('same certificate');

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.owner(ownerId);
      if (!before || before.subjectId !== subjectId ||
          before.certificateId !== previousCertificateId) {
        throw new Error('stale or foreign certificate');
      }
      if (this.#db.prepare(`INSERT OR IGNORE INTO used_nonces (owner_id, nonce)
        VALUES (?, ?)`).run(ownerId, nonce).changes !== 1) throw new Error('replay');
      this.#db.prepare(`UPDATE owners SET certificate_id = ?, auth_epoch = auth_epoch + 1
        WHERE owner_id = ?`).run(newCertificateId, ownerId);
      this.#db.exec('COMMIT');
      return this.owner(ownerId);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
