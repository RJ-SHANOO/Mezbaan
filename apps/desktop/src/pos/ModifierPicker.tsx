import { useState, type ReactElement } from "react";
import type { ModifierGroup, ModifierOption } from "../shared/menu-client.js";
import { formatPrice } from "./format-price.js";

interface ModifierPickerProps {
  productName: string;
  groups: ModifierGroup[];
  onConfirm: (selectedOptions: ModifierOption[]) => void;
  onCancel: () => void;
}

/**
 * P2-12: the modifier-selection step shown before an item with attached
 * modifier groups is added to the cart. A group with maxSelections === 1
 * behaves like a radio group (picking a new option replaces the old one);
 * any other group (including uncapped) is checkboxes. "Add to cart" is
 * disabled until every group's own min/max is satisfied — the same rule
 * OrderItemsService enforces server-side, enforced here too so a cashier
 * gets the feedback immediately rather than after a later sync.
 */
export function ModifierPicker({ productName, groups, onConfirm, onCancel }: ModifierPickerProps): ReactElement {
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>({});

  function selectedIn(groupId: string): string[] {
    return selectedByGroup[groupId] ?? [];
  }

  function toggleOption(group: ModifierGroup, optionId: string): void {
    setSelectedByGroup((prev) => {
      const current = prev[group.id] ?? [];
      const isSelected = current.includes(optionId);
      if (group.maxSelections === 1) {
        return { ...prev, [group.id]: isSelected ? [] : [optionId] };
      }
      const next = isSelected ? current.filter((id) => id !== optionId) : [...current, optionId];
      return { ...prev, [group.id]: next };
    });
  }

  const unsatisfiedGroup = groups.find((group) => {
    const count = selectedIn(group.id).length;
    return count < group.minSelections || (group.maxSelections !== null && count > group.maxSelections);
  });

  function handleConfirm(): void {
    const selected = groups.flatMap((group) => group.options.filter((option) => selectedIn(group.id).includes(option.id)));
    onConfirm(selected);
  }

  return (
    <div role="dialog" aria-label={`Choose modifiers for ${productName}`} className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col gap-4 overflow-y-auto rounded-lg bg-white p-4">
        <h2 className="text-base font-semibold text-slate-800">{productName}</h2>

        {groups.map((group) => {
          const count = selectedIn(group.id).length;
          const requirementText =
            group.minSelections > 0
              ? `Choose ${group.maxSelections === group.minSelections ? group.minSelections : `${group.minSelections}-${group.maxSelections ?? "any"}`}`
              : group.maxSelections !== null
                ? `Choose up to ${group.maxSelections}`
                : "Optional";

          return (
            <fieldset key={group.id} className="border-t border-slate-100 pt-3">
              <legend className="mb-2 flex w-full items-center justify-between text-sm font-medium text-slate-700">
                <span>{group.name}</span>
                <span className="text-xs text-slate-400">
                  {requirementText} ({count} selected)
                </span>
              </legend>
              <div className="flex flex-col gap-1">
                {group.options.map((option) => (
                  <label key={option.id} className="flex items-center justify-between gap-2 text-sm text-slate-600">
                    <span className="flex items-center gap-2">
                      <input
                        type={group.maxSelections === 1 ? "radio" : "checkbox"}
                        name={group.id}
                        checked={selectedIn(group.id).includes(option.id)}
                        onChange={() => toggleOption(group, option.id)}
                      />
                      {option.name}
                    </span>
                    <span className="text-xs text-slate-400">{formatPrice(option.unitPriceMinor, option.currency)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={unsatisfiedGroup !== undefined}
            className="rounded-lg bg-brand-purple px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add to cart
          </button>
        </div>
      </div>
    </div>
  );
}
