export type OrderStatus = "open" | "held" | "closed" | "cancelled";

export class IllegalOrderStatusTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Illegal order status transition: ${from} -> ${to}`);
    this.name = "IllegalOrderStatusTransitionError";
  }
}

/**
 * P2-14: "held" is a parked ticket — ongoing work (seat/course, modifiers)
 * that isn't being billed right now. It can be recalled back to open, or
 * abandoned outright (cancelled), but can't be closed directly: billing a
 * ticket always goes through the normal open state first, same as any
 * other order.
 */
const ALLOWED_ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  open: ["held", "closed", "cancelled"],
  held: ["open", "cancelled"],
  closed: [],
  cancelled: [],
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/** Throws IllegalOrderStatusTransitionError instead of returning a boolean, for callers that have no legal fallback. */
export function assertCanTransitionOrderStatus(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrderStatus(from, to)) {
    throw new IllegalOrderStatusTransitionError(from, to);
  }
}
