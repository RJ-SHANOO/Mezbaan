/**
 * P3-08: converting a physical quantity between two of an inventory item's
 * own units (e.g. "2 cartons" of eggs → "60 piece") — not money, so rule
 * 5's integer-minor-units requirement doesn't apply here; plain floating-
 * point is the right fit for physical quantities the way it never is for
 * currency.
 *
 * `factors` is a star shape centered on the item's own base unit: each
 * entry says how many base units equal one of that key's unit (the base
 * unit itself needs no entry — its own factor is always 1 by definition).
 * Converting between two NON-base units still only needs one multiply and
 * one divide, via the base unit as the common ground — no pairwise table.
 */
export function convertQuantity(quantity: number, fromUnitId: string, toUnitId: string, baseUnitId: string, factors: ReadonlyMap<string, number>): number {
  if (fromUnitId === toUnitId) return quantity;

  const fromFactor = fromUnitId === baseUnitId ? 1 : factors.get(fromUnitId);
  const toFactor = toUnitId === baseUnitId ? 1 : factors.get(toUnitId);
  if (fromFactor === undefined) throw new Error(`convertQuantity: no conversion factor registered for unit ${fromUnitId}`);
  if (toFactor === undefined) throw new Error(`convertQuantity: no conversion factor registered for unit ${toUnitId}`);

  const inBaseUnits = quantity * fromFactor;
  return inBaseUnits / toFactor;
}
