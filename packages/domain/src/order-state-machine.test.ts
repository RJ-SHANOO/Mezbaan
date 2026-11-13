import { describe, expect, it } from "vitest";
import {
  IllegalOrderStatusTransitionError,
  assertCanTransitionOrderStatus,
  canTransitionOrderStatus,
  type OrderStatus,
} from "./order-state-machine.js";

describe("order state machine", () => {
  const legal: [OrderStatus, OrderStatus][] = [
    ["open", "held"],
    ["open", "closed"],
    ["open", "cancelled"],
    ["held", "open"],
    ["held", "cancelled"],
  ];

  it.each(legal)("allows %s -> %s", (from, to) => {
    expect(canTransitionOrderStatus(from, to)).toBe(true);
    expect(() => assertCanTransitionOrderStatus(from, to)).not.toThrow();
  });

  const illegal: [OrderStatus, OrderStatus][] = [
    ["held", "closed"],
    ["closed", "open"],
    ["closed", "held"],
    ["closed", "cancelled"],
    ["cancelled", "open"],
    ["cancelled", "held"],
    ["cancelled", "closed"],
    ["open", "open"],
    ["held", "held"],
    ["closed", "closed"],
    ["cancelled", "cancelled"],
  ];

  it.each(illegal)("rejects %s -> %s", (from, to) => {
    expect(canTransitionOrderStatus(from, to)).toBe(false);
    expect(() => assertCanTransitionOrderStatus(from, to)).toThrow(IllegalOrderStatusTransitionError);
  });
});
