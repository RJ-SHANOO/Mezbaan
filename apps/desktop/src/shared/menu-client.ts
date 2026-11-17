import { invoke } from "@tauri-apps/api/core";

const API_POS_BASE_URL = import.meta.env.VITE_API_POS_URL ?? "http://localhost:3001";
const SYNC_PUBLIC_KEY_PEM = import.meta.env.VITE_SYNC_PUBLIC_KEY_PEM ?? "";

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MenuProduct {
  id: string;
  categoryId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  sortOrder: number;
  /** Null when nothing's been priced for this product yet — not an error. */
  unitPriceMinor: string | null;
  currency: string | null;
}

export interface ModifierOption {
  id: string;
  name: string;
  sortOrder: number;
  /** Null when this option has no price list entry — a free customization,
   * not an error. */
  unitPriceMinor: string | null;
  currency: string | null;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number | null;
  sortOrder: number;
  options: ModifierOption[];
}

export interface AppliedTaxRule {
  name: string;
  rateBasisPoints: number;
}

/** P2-45: one order type's already-resolved tax/service-charge config,
 * synced down by P1-27's snapshot — the input packages/domain's
 * computeCharges needs to price an offline sale, with no network call. */
export interface TaxConfig {
  orderType: string;
  pricingMode: "inclusive" | "exclusive";
  taxRateBasisPoints: number;
  appliedTaxRules: AppliedTaxRule[];
  serviceChargeRateBasisPoints: number | null;
  serviceChargeIsTaxable: boolean | null;
}

/** P2-11: thin wrappers over the menu_cache Tauri commands — every call here
 * reads from the terminal's own local SQLite cache, with no network call in
 * the sale path (rule: "no network call in the sale path"). */
export function getMenuCategories(): Promise<MenuCategory[]> {
  return invoke<MenuCategory[]>("get_menu_categories");
}

export function getMenuProducts(categoryId: string | null, search: string | null): Promise<MenuProduct[]> {
  return invoke<MenuProduct[]>("get_menu_products", { categoryId, search });
}

export function findMenuProductByBarcode(barcode: string): Promise<MenuProduct | null> {
  return invoke<MenuProduct | null>("find_menu_product_by_barcode", { barcode });
}

/** P2-12: the modifier groups/options attached to one product — what the
 * cart's modifier-selection step needs before an item can be added. */
export function getModifierGroupsForProduct(productId: string): Promise<ModifierGroup[]> {
  return invoke<ModifierGroup[]>("get_modifier_groups_for_product", { productId });
}

/** The one command here that *does* call the network — pulls a fresh signed
 * snapshot and replaces the local cache. Callers should treat failure as
 * routine (e.g. offline) and keep showing whatever's already cached, never
 * block on this. */
export function syncMenu(): Promise<string> {
  return invoke<string>("sync_menu", { apiBaseUrl: API_POS_BASE_URL, publicKeyPem: SYNC_PUBLIC_KEY_PEM });
}

/** P2-17: the "prices as of" version from the last successful sync_menu, read
 * straight from local storage — no network call, so it's available immediately
 * on mount even before (or if) this session's own sync_menu resolves. */
export function getMenuSyncVersion(): Promise<string | null> {
  return invoke<string | null>("get_menu_sync_version");
}

/** P2-45: null means this order type was never synced (e.g. a restaurant
 * hasn't configured any tax rules at all), not an error. */
export function getTaxConfig(orderType: string): Promise<TaxConfig | null> {
  return invoke<TaxConfig | null>("get_tax_config", { orderType });
}
