import type { Building } from "@/lib/types";

type Props = {
  building: Building | null;
  onClose: () => void;
};

function formatArchitects(architects: Building["architects"]) {
  if (!architects) return "Unknown";

  // If it's already an array (your current type), join nicely
  if (Array.isArray(architects)) {
    const cleaned = architects
      .map((a) => String(a).trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    return cleaned.length ? cleaned.join(", ") : "Unknown";
  }

  // Safety: if it ever comes as a string, strip brackets/quotes
  return String(architects)
    .replace(/^\s*\[|\]\s*$/g, "")
    .replace(/"/g, "")
    .trim() || "Unknown";
}

export function DetailsPanel({ building, onClose }: Props) {
  if (!building) return null;

  const title =
    building.name?.trim() || building.address?.trim() || "Unknown building";

  const architects = formatArchitects(building.architects);

  return (
    <>
      <button
        aria-label="Close details"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
      />
      <aside
        className="
          fixed z-50 bg-white shadow-xl text-gray-900
          md:top-0 md:right-0 md:h-full md:w-[420px] md:rounded-l-2xl
          bottom-0 left-0 right-0 md:left-auto
          rounded-t-2xl md:rounded-t-none
          max-h-[70vh] md:max-h-none
          overflow-auto
        "
      >
        <div className="sticky top-0 bg-white/95 backdrop-blur border-b px-4 py-3 flex items-center justify-between">
          <div className="font-semibold text-base text-gray-900">{title}</div>
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1 text-sm border text-gray-800 hover:bg-gray-50"
          >
            Close
          </button>
        </div>

        <div className="p-4 space-y-5">
        {building.imageThumbUrl || building.imageFullUrl ? (
            <div>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Photo
              </div>

              <a
                href={building.imageFullUrl || building.imageThumbUrl || "#"}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block"
              >
                <img
                  src={building.imageThumbUrl || building.imageFullUrl || ""}
                  alt={title}
                  className="w-full rounded-xl border"
                  loading="lazy"
                />
              </a>
            </div>
          ) : null}

          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Built year
            </div>
            <div className="mt-1 text-sm text-gray-900">
              {building.builtYear || "Unknown"}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Address
            </div>
            <div className="mt-1 text-sm text-gray-900">
              {building.address || "Unknown"}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Architect(s)
            </div>
            <div className="mt-1 text-sm text-gray-900">{architects}</div>
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Description
            </div>
            <div className="mt-1 text-sm text-gray-900 whitespace-pre-wrap leading-relaxed">
              {building.description || "No description yet."}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
