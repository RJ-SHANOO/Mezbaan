import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  findMenuProductByBarcode,
  getMenuCategories,
  getMenuProducts,
  getMenuSyncVersion,
  getModifierGroupsForProduct,
  syncMenu,
  type MenuProduct,
  type ModifierGroup,
  type ModifierOption,
} from "../shared/menu-client.js";
import { completeOfflineSale } from "../shared/offline-sale-client.js";
import { addLine, modifierToCartLineModifier, removeLine, type CartLine } from "./cart.js";
import { CartPanel, type CheckoutStatus } from "./CartPanel.js";
import { CategoryGrid } from "./CategoryGrid.js";
import { ModifierPicker } from "./ModifierPicker.js";
import { ProductGrid } from "./ProductGrid.js";
import { useBarcodeScanner } from "./useBarcodeScanner.js";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";

/** P2-11's screen has no order-type selector yet (see menu_cache.rs's own
 * docs) — checkout shares that same deliberate simplification. */
const DEFAULT_ORDER_TYPE = "dine_in";

/**
 * P2-11: the touch-first POS screen — category grid, free-text search,
 * barcode scanning and keyboard shortcuts, all reading the local menu cache
 * (menu_cache.rs via menu-client.ts) with no network call in this path.
 * Fires a background sync on mount to refresh that cache; a failed sync
 * (e.g. offline) is swallowed and surfaced as a small inline note — it
 * never blocks rendering whatever's already cached locally.
 *
 * P2-17: alongside that error note, a persistent status line shows whether a
 * sync is in progress and, once known, the "prices as of" version from the
 * last one that succeeded — read from local storage via getMenuSyncVersion
 * so it's there immediately on mount, not just after this mount's own
 * syncMenu call resolves (e.g. right after an error-boundary reset).
 */
export function PosScreen(): ReactElement {
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [menuVersion, setMenuVersion] = useState<string | null>(null);
  const [isSyncingMenu, setIsSyncingMenu] = useState(true);
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [modifierPicker, setModifierPicker] = useState<{ product: MenuProduct; groups: ModifierGroup[] } | null>(null);
  const [cartError, setCartError] = useState<string | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus>({ kind: "idle" });
  // Generated once per checkout attempt, kept stable across a retry (e.g. a
  // double-click, or clicking Checkout again after a transient error) so
  // offline_sales.rs's idempotency check returns the original sale rather
  // than creating a duplicate one. Cleared only once that attempt actually
  // succeeds, so the *next* sale gets a fresh key.
  const checkoutIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getMenuSyncVersion()
      .then((version) => {
        if (!cancelled) setMenuVersion(version);
      })
      .catch(() => {
        // Best-effort seed only — the syncMenu() result below is authoritative.
      });

    syncMenu()
      .then((version) => {
        if (!cancelled) {
          setSyncError(null);
          setMenuVersion(version);
          void queryClient.invalidateQueries({ queryKey: ["menu"] });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setSyncError(error instanceof Error ? error.message : "Couldn't refresh the menu.");
      })
      .finally(() => {
        if (!cancelled) setIsSyncingMenu(false);
      });

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  // retry: false — these read the local SQLite cache, not the network. A
  // failure here (e.g. "local database unavailable") is a stable condition,
  // not a transient blip retrying-with-backoff would ever resolve.
  const categoriesQuery = useQuery({ queryKey: ["menu", "categories"], queryFn: getMenuCategories, retry: false });
  const productsQuery = useQuery({
    queryKey: ["menu", "products", selectedCategoryId, search],
    queryFn: () => getMenuProducts(selectedCategoryId, search.trim() === "" ? null : search.trim()),
    retry: false,
  });

  const categories = categoriesQuery.data ?? [];
  const products = productsQuery.data ?? [];

  const addProductToCart = useCallback((product: MenuProduct, modifiers: ModifierOption[] = []) => {
    setCartError(null);
    setCheckoutStatus({ kind: "idle" });
    const line: CartLine = {
      lineId: crypto.randomUUID(),
      productId: product.id,
      name: product.name,
      quantity: 1,
      unitPriceMinor: product.unitPriceMinor ?? "0",
      currency: product.currency ?? "PKR",
      modifiers: modifiers.map((option) => modifierToCartLineModifier(option, product.currency ?? "PKR")),
    };
    setCartLines((lines) => addLine(lines, line));
  }, []);

  const handleProductTap = useCallback(
    (product: MenuProduct) => {
      setSelectedProductId(product.id);
      if (product.unitPriceMinor === null) {
        setCartError(`${product.name} has no price configured yet and can't be added to the cart.`);
        return;
      }
      getModifierGroupsForProduct(product.id)
        .then((groups) => {
          if (groups.length === 0) {
            addProductToCart(product);
          } else {
            setModifierPicker({ product, groups });
          }
        })
        .catch(() => setCartError(`Couldn't load modifiers for ${product.name}.`));
    },
    [addProductToCart],
  );

  const handleCheckout = useCallback(() => {
    if (cartLines.length === 0 || checkoutStatus.kind === "checkingOut") return;
    checkoutIdempotencyKeyRef.current ??= crypto.randomUUID();
    const idempotencyKey = checkoutIdempotencyKeyRef.current;
    setCheckoutStatus({ kind: "checkingOut" });
    completeOfflineSale(DEFAULT_ORDER_TYPE, cartLines[0]!.currency, cartLines, idempotencyKey)
      .then((invoice) => {
        setCheckoutStatus({ kind: "success", invoice });
        setCartLines([]);
        checkoutIdempotencyKeyRef.current = null;
      })
      .catch((error: unknown) => {
        setCheckoutStatus({ kind: "error", message: error instanceof Error ? error.message : "Couldn't complete the sale." });
      });
  }, [cartLines, checkoutStatus.kind]);

  const handleScan = useCallback(
    (code: string) => {
      findMenuProductByBarcode(code)
        .then((product) => {
          if (product) {
            setSelectedCategoryId(product.categoryId);
            setSearch("");
            setScanNotice(`Scanned: ${product.name}`);
            handleProductTap(product);
          } else {
            setScanNotice(`Barcode not recognized: ${code}`);
          }
        })
        .catch(() => setScanNotice(`Couldn't look up barcode: ${code}`));
    },
    [handleProductTap],
  );
  useBarcodeScanner(handleScan);

  useKeyboardShortcuts({
    categoryCount: categories.length,
    onSelectCategoryByIndex: (index) => setSelectedCategoryId(categories[index]?.id ?? null),
    onFocusSearch: () => searchInputRef.current?.focus(),
    onClearSearch: () => setSearch(""),
  });

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-slate-50 p-4">
      <div className="flex items-center gap-3">
        <input
          ref={searchInputRef}
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, SKU or barcode… (press / to focus)"
          aria-label="Search products"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none"
        />
      </div>

      {scanNotice && (
        <p className="text-sm text-slate-500" role="status">
          {scanNotice}
        </p>
      )}
      <p className="text-xs text-slate-400" role="status">
        {isSyncingMenu
          ? "Syncing prices…"
          : menuVersion
            ? `Prices as of ${new Date(menuVersion).toLocaleTimeString()}`
            : "Prices not yet synced"}
      </p>
      {syncError && (
        <p className="text-xs text-amber-600" role="status">
          Menu may be out of date: {syncError}
        </p>
      )}
      {cartError && (
        <p className="text-sm text-red-600" role="alert">
          {cartError}
        </p>
      )}

      <div className="flex flex-1 gap-4">
        <div className="flex flex-1 flex-col gap-4">
          {categoriesQuery.isError && (
            <p className="text-sm text-red-600" role="alert">
              Couldn't load categories from the local cache.
            </p>
          )}
          <CategoryGrid categories={categories} selectedCategoryId={selectedCategoryId} onSelect={setSelectedCategoryId} />

          {productsQuery.isError ? (
            <p className="py-8 text-center text-sm text-red-600" role="alert">
              Couldn't load products from the local cache.
            </p>
          ) : (
            <ProductGrid
              products={products}
              selectedProductId={selectedProductId}
              onSelect={(productId) => {
                const product = products.find((p) => p.id === productId);
                if (product) handleProductTap(product);
              }}
              emptyMessage={productsQuery.isLoading ? "Loading menu…" : "No products match."}
            />
          )}
        </div>

        <CartPanel
          lines={cartLines}
          onRemove={(lineId) => setCartLines((lines) => removeLine(lines, lineId))}
          onCheckout={handleCheckout}
          checkoutStatus={checkoutStatus}
        />
      </div>

      {modifierPicker && (
        <ModifierPicker
          productName={modifierPicker.product.name}
          groups={modifierPicker.groups}
          onCancel={() => setModifierPicker(null)}
          onConfirm={(selectedOptions) => {
            addProductToCart(modifierPicker.product, selectedOptions);
            setModifierPicker(null);
          }}
        />
      )}
    </div>
  );
}
