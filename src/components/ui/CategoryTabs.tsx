"use client";

/**
 * Gallery category filter tabs (#284) — shared by the photo / video / audio
 * galleries so the filter UI is one component. Presentational: the parent owns
 * the active-category state and the filtering.
 */
export default function CategoryTabs({
  categories,
  active,
  onSelect,
}: {
  categories: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  // A single "All" tab with nothing else to pick is noise — hide the bar.
  if (categories.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-8">
      {categories.map((cat) => (
        <button
          key={cat.key}
          onClick={() => onSelect(cat.key)}
          className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-lg border transition-colors ${
            active === cat.key
              ? "border-accent-400/30 bg-accent-400/10 text-accent-400"
              : "border-surface-700 text-gray-500 hover:text-gray-300 hover:border-surface-600"
          }`}
        >
          {cat.label}
        </button>
      ))}
    </div>
  );
}
