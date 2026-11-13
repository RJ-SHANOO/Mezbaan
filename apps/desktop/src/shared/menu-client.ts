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
