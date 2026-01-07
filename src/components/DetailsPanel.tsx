import type { Building } from "@/lib/types";

type Props = {
  building: Building | null;
  onClose: () => void;
};

export function DetailsPanel({ building, onClose }: Props) {
  if (!building) return null;

  const title = building.name?.trim() || building.address?.trim() || "Unknown building";
  const architects =
    building.architects && building.architects.length > 0
      ? building.architects.join(", ")
      : "Unknown";

  return (
    <>
      <button
        aria-label="Close details"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
      />
      <aside
        className="
          fixed z-50 bg-white shadow-xl
          md:top-0 md:right-0 md:h-full md:w-[420px] md:rounded-l-2xl
          bottom-0 left-0 right-0 md:left-auto
          rounded-t-2xl md:rounded-t-none
          max-h-[70vh] md:max-h-none
          overflow-auto
        "
      >
        <div className="sticky top-0 bg-white/90 backdrop-blur border-b px-4 py-3 flex items-center justify-between">
          <div className="font-semibold text-base">{title}</div>
          <button onClick={onClose} className="rounded-lg px-3 py-1 text-sm border hover:bg-gray-50">
            Close
          </button>
        </div>

        <div className="p-4 space-y-3 text-sm">
          <div>
            <div className="text-gray-500">Address</div>
            <div>{building.address || "Unknown"}</div>
          </div>
          <div>
            <div className="text-gray-500">Architect(s)</div>
            <div>{architects}</div>
          </div>
          <div>
            <div className="text-gray-500">Description</div>
            <div className="whitespace-pre-wrap">{building.description || "No description yet."}</div>
          </div>
        </div>
      </aside>
    </>
  );
}
