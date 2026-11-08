import { describe, expect, it } from "vitest";
import { getSnapshotPublicKeyPem, signBytes, verifyBytes } from "./snapshot-signing.js";

describe("snapshot-signing", () => {
  it("signs bytes and verifies them against the matching public key", () => {
    const data = '{"hello":"world"}';
    const signature = signBytes(data);
    expect(verifyBytes(data, signature)).toBe(true);
  });

  it("rejects a signature if the bytes were tampered with", () => {
    const signature = signBytes('{"hello":"world"}');
    expect(verifyBytes('{"hello":"tampered"}', signature)).toBe(false);
  });

  it("rejects a tampered signature over the original bytes", () => {
    const data = '{"hello":"world"}';
    const signature = signBytes(data);
    const tampered = signature.slice(0, -4) + "AAAA";
    expect(verifyBytes(data, tampered)).toBe(false);
  });

  it("exposes a stable PEM-encoded public key across calls within the same process", () => {
    expect(getSnapshotPublicKeyPem()).toBe(getSnapshotPublicKeyPem());
    expect(getSnapshotPublicKeyPem()).toContain("BEGIN PUBLIC KEY");
  });
});
