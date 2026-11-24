import { NotFoundException, BadRequestException } from "@nestjs/common";
import { convertQuantity } from "@mezbaan/domain";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@mezbaan/db";

/**
 * Shared by ProductionService (P3-16), SalesStockDeductionService (P3-17)
 * and GoodsReceivedNotesService (P3-22) — all three take a quantity in
 * whatever unit the caller's own document was written in (a recipe line,
 * a purchase order line) and need it in the ingredient's own base unit
 * (inventory_items.baseUnitId) before ever touching stock_ledger, same
 * "this table never converts on its own" rule stock-ledger.ts's own docs
 * state. Deliberately inlined against the caller's own `tx` rather than
 * calling InventoryItemUnitConversionsService (which always opens its own
 * separate transaction) — every caller needs this as one step inside a
 * single larger atomic write.
 */
export async function convertItemQuantityToBaseUnit(tx: Database, itemId: string, quantity: number, fromUnitId: string): Promise<number> {
  const itemRows = await tx.select({ baseUnitId: schema.inventoryItems.baseUnitId }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, itemId));
  const item = itemRows[0];
  if (!item) throw new NotFoundException("Inventory item not found");

  const conversionRows = await tx.select().from(schema.inventoryItemUnitConversions).where(eq(schema.inventoryItemUnitConversions.itemId, itemId));
  const factors = new Map(conversionRows.map((row) => [row.unitId, row.factorToBaseUnit]));

  try {
    return convertQuantity(quantity, fromUnitId, item.baseUnitId, item.baseUnitId, factors);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "Couldn't convert this line's unit to the item's own base unit");
  }
}
