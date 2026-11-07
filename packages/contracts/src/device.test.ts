import { describe, expect, it } from "vitest";
import { CreateDeviceSchema, DeviceSchema, RedeemPairingCodeSchema } from "./device.js";

describe("CreateDeviceSchema", () => {
  it("accepts a well-formed device", () => {
    const branchId = "11111111-1111-7111-8111-111111111111";
    expect(CreateDeviceSchema.parse({ label: "Front Counter", deviceType: "pos_terminal", branchId })).toEqual({
      label: "Front Counter",
      deviceType: "pos_terminal",
      branchId,
    });
  });

  it("rejects an empty label, an invalid device type, or a non-uuid branchId", () => {
    const branchId = "11111111-1111-7111-8111-111111111111";
    expect(() => CreateDeviceSchema.parse({ label: "", deviceType: "pos_terminal", branchId })).toThrow();
    expect(() => CreateDeviceSchema.parse({ label: "Front Counter", deviceType: "fridge", branchId })).toThrow();
    expect(() => CreateDeviceSchema.parse({ label: "Front Counter", deviceType: "pos_terminal", branchId: "not-a-uuid" })).toThrow();
  });
});

describe("RedeemPairingCodeSchema", () => {
  it("rejects an empty pairing code", () => {
    expect(() => RedeemPairingCodeSchema.parse({ pairingCode: "" })).toThrow();
  });
});

describe("DeviceSchema", () => {
  it("accepts a revoked device with no lastSeenAt", () => {
    const device = {
      id: "11111111-1111-7111-8111-111111111111",
      branchId: "22222222-2222-7222-8222-222222222222",
      label: "Front Counter",
      deviceType: "pos_terminal",
      status: "revoked",
      lastSeenAt: null,
      createdAt: new Date().toISOString(),
    };
    expect(DeviceSchema.parse(device)).toEqual(device);
  });
});
