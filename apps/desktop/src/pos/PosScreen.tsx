import { invoke } from "@tauri-apps/api/core";
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
import { getDeviceIdentity } from "../shared/device-identity-client.js";
import { connectToBranchHub } from "../shared/hub-connection.js";
import type { HubClient } from "../shared/hub-client.js";
import { completeOfflineSale } from "../shared/offline-sale-client.js";
import { addLine, modifierToCartLineModifier, removeLine, type CartLine } from "./cart.js";
import { CartPanel, type CheckoutStatus } from "./CartPanel.js";
import { CategoryGrid } from "./CategoryGrid.js";
import { ModifierPicker } from "./ModifierPicker.js";
import { buildOfflineKitchenTicket, offlineTicketEntityId } from "./offline-kitchen-ticket.js";
import { ProductGrid } from "./ProductGrid.js";
import { useBarcodeScanner } from "./useBarcodeScanner.js";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";

/** P2-11's screen has no order-type selector yet (see menu_cache.rs's own
 * docs) — checkout shares that same deliberate simplification. "takeaway",
 * not "dine_in": a dine-in order requires a tableId (the orders table's own
 * CHECK constraint), and there is no table-selection UI here to supply one —
 * P2-45's exit-gate hardening found this would otherwise reject every synced
 * offline sale once the order actually reached the server. */
const DEFAULT_ORDER_TYPE = "takeaway";

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

  // P3-05: a stable id for this cart session, used only as the hub relay's
  // ticket orderId (there is no real server-side order yet — see
  // offline-kitchen-ticket.ts). Regenerated once the sale actually
  // completes, same lifecycle as checkoutIdempotencyKeyRef's own reset.
  const draftOrderIdRef = useRef<string>(crypto.randomUUID());
  const [firedLineIds, setFiredLineIds] = useState<Set<string>>(new Set());
  const [rushNextFire, setRushNextFire] = useState(false);
  const hubClientRef = useRef<HubClient | null>(null);
  const [hubConnected, setHubConnected] = useState(false);
  // No real server-assigned device id is known client-side (only
  // branch/terminal numbers) — this is only ever shown to a human as
  // "who sent this," never used for auth (the hub already verified this
  // connection's token), so a stable, available label is enough.
  const deviceLabelRef = useRef<string>("pos-terminal");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [deviceToken, identity] = await Promise.all([invoke<string | null>("get_device_token"), getDeviceIdentity()]);
      if (cancelled || !deviceToken || !identity?.restaurantId) return;
      deviceLabelRef.current = `pos-b${identity.branchNumber}-t${identity.terminalNumber}`;
      const client = await connectToBranchHub(identity.restaurantId, deviceToken, {
        onConnectionStateChange: (state) => {
          if (!cancelled) setHubConnected(state === "open");
        },
      });
      if (cancelled) {
        client?.close();
        return;
      }
      hubClientRef.current = client;
      setHubConnected(client?.getConnectionState() === "open");
    })().catch(() => {
      // No hub reachable — kitchen tickets just won't relay over the LAN;
      // never block the POS screen itself over this (rule 14).
    });
    return () => {
      cancelled = true;
      hubClientRef.current?.close();
      hubClientRef.current = null;
    };
  }, []);

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
      priceListId: product.priceListId,
      priceListVersion: product.priceListVersion,
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
        draftOrderIdRef.current = crypto.randomUUID();
        setFiredLineIds(new Set());
      })
      .catch((error: unknown) => {
        setCheckoutStatus({ kind: "error", message: error instanceof Error ? error.message : "Couldn't complete the sale." });
      });
  }, [cartLines, checkoutStatus.kind]);

  /** P3-05: fires every not-yet-fired cart line to the kitchen over the
   * branch hub — purely a LAN relay, no cloud call at all, since there is
   * no real server-side order for an in-progress offline sale to attach a
   * fire event to (see offline-kitchen-ticket.ts). A no-op, not an error,
   * when the hub isn't reachable or every line is already fired. */
  const handleFireToKitchen = useCallback(() => {
    const unfired = cartLines.filter((line) => !firedLineIds.has(line.lineId));
    if (unfired.length === 0) return;
    const ticket = buildOfflineKitchenTicket(draftOrderIdRef.current, unfired, rushNextFire);
    hubClientRef.current?.send({
      entityKind: "kitchen_ticket",
      entityId: offlineTicketEntityId(ticket),
      version: Date.now(),
      originDeviceId: deviceLabelRef.current,
      payload: ticket,
    });
    setFiredLineIds((ids) => new Set([...ids, ...unfired.map((line) => line.lineId)]));
    setRushNextFire(false);
  }, [cartLines, firedLineIds, rushNextFire]);

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
          firedLineIds={firedLineIds}
          onFireToKitchen={handleFireToKitchen}
          rush={rushNextFire}
          onRushChange={setRushNextFire}
          hubConnected={hubConnected}
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
