import type { ReactElement } from "react";
import type { MenuCategory } from "../shared/menu-client.js";

interface CategoryGridProps {
  categories: MenuCategory[];
  selectedCategoryId: string | null;
  onSelect: (categoryId: string | null) => void;
}

/** P2-11: the category grid. "All" (index 0 for the 1-9 keyboard shortcut,
 * see useKeyboardShortcuts) plus one tile per synced category, numbered so
 * the shortcut's correspondence is visible, not just a hidden behavior. */
export function CategoryGrid({ categories, selectedCategoryId, onSelect }: CategoryGridProps): ReactElement {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" role="list" aria-label="Categories">
      <CategoryTile label="All" shortcutNumber={null} selected={selectedCategoryId === null} onClick={() => onSelect(null)} />
      {categories.map((category, index) => (
        <CategoryTile
          key={category.id}
          label={category.name}
          shortcutNumber={index < 9 ? index + 1 : null}
          selected={selectedCategoryId === category.id}
          onClick={() => onSelect(category.id)}
        />
      ))}
    </div>
  );
}

function CategoryTile({
  label,
  shortcutNumber,
  selected,
  onClick,
}: {
  label: string;
  shortcutNumber: number | null;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      aria-pressed={selected}
      className={`relative rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
        selected ? "bg-brand-purple text-white" : "bg-white text-slate-700 hover:bg-slate-100"
      }`}
    >
      {shortcutNumber !== null && (
        <span className={`absolute left-1.5 top-1 text-[10px] ${selected ? "text-white/70" : "text-slate-400"}`}>{shortcutNumber}</span>
      )}
      {label}
    </button>
  );
}
