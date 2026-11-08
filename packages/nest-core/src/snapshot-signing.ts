import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export interface SnapshotKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

let cachedKeyPair: SnapshotKeyPair | undefined;

/**
 * The keypair every downstream sync snapshot (P1-27) is signed with. Reads
 * SYNC_SNAPSHOT_PRIVATE_KEY_PEM (an Ed25519 private key, PEM-encoded) for a real
 * deployment; with nothing set, generates a fresh keypair once per process.
 *
 * Deliberately not a hardcoded dev default the way DEV_JWT_SECRET is: a JWT secret
 * has to stay stable across restarts so tokens issued earlier keep verifying in the
 * same dev session, but a snapshot's signature only ever needs to verify against
 * its own response in the same request — there's no reason to want a *fixed*
 * well-known private key in source for that, and every reason not to.
 */
export function getSnapshotKeyPair(): SnapshotKeyPair {
  if (cachedKeyPair) return cachedKeyPair;

  const pem = process.env.SYNC_SNAPSHOT_PRIVATE_KEY_PEM;
  if (pem) {
    const privateKey = createPrivateKey(pem);
    cachedKeyPair = { privateKey, publicKey: createPublicKey(privateKey) };
    return cachedKeyPair;
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  cachedKeyPair = { privateKey, publicKey };
  return cachedKeyPair;
}

/** Signs the exact bytes given — never re-serialize JSON before verifying a
 * signature produced this way: Rust's and JS's JSON encoders don't promise the
 * same key order, so the client must verify against the identical string it
 * received, not a round-tripped re-encoding of it. */
export function signBytes(data: string): string {
  const { privateKey } = getSnapshotKeyPair();
  return sign(null, Buffer.from(data, "utf8"), privateKey).toString("base64");
}

export function getSnapshotPublicKeyPem(): string {
  return getSnapshotKeyPair().publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** Exists for this package's own tests — the real verification happens client-side
 * (P1-27b), against the public key distributed out of band, not fetched live. */
export function verifyBytes(data: string, signatureBase64: string): boolean {
  const { publicKey } = getSnapshotKeyPair();
  return verify(null, Buffer.from(data, "utf8"), publicKey, Buffer.from(signatureBase64, "base64"));
}
