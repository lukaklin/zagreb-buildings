"use client";

import { Calendar, MapPin, User, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Building } from "@/lib/types";
import { ImageWithFallback } from "./ImageWithFallback";
import { Button } from "./ui/button";

type Props = {
  building: Building | null;
  onClose: () => void;
};

function formatArchitects(architects: Building["architects"]) {
  if (!architects) return null;

  if (Array.isArray(architects)) {
    const cleaned = architects
      .map((a) => String(a).trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    return cleaned.length ? cleaned.join(", ") : null;
  }

  const s = String(architects)
    .replace(/^\s*\[|\]\s*$/g, "")
    .replace(/"/g, "")
    .trim();
  return s || null;
}

export function DetailsPanel({ building, onClose }: Props) {
  const title =
    building?.name?.trim() || building?.address?.trim() || "Unknown building";
  const architects = building ? formatArchitects(building.architects) : null;
  const imageUrl =
    building?.imageThumbUrl || building?.imageFullUrl || null;

  return (
    <AnimatePresence>
      {building && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/30 md:z-[1001]"
            aria-hidden
          />

          {/* Panel */}
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="
              fixed z-50 bg-white shadow-2xl text-gray-900 overflow-hidden
              md:top-0 md:right-0 md:h-full md:w-[420px] md:z-[1002]
              bottom-0 left-0 right-0 md:left-auto
              max-h-[70vh] md:max-h-none
            "
          >
            <div className="flex h-full flex-col overflow-auto">
              {/* Hero image */}
              {imageUrl ? (
                <div className="relative h-64 w-full shrink-0">
                  <a
                    href={building.imageFullUrl || building.imageThumbUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="block size-full"
                  >
                    <ImageWithFallback
                      src={imageUrl}
                      alt={title}
                      className="size-full object-cover"
                    />
                  </a>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    aria-label="Close details"
                    className="absolute right-4 top-4 bg-white/90 hover:bg-white"
                  >
                    <X className="size-5 text-gray-800" />
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
                  <h2 className="font-semibold text-base text-gray-900">
                    {title}
                  </h2>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onClose}
                    aria-label="Close details"
                  >
                    Close
                  </Button>
                </div>
              )}

              {/* Content */}
              <div className="flex-1 p-6 space-y-6 overflow-auto">
                {imageUrl && (
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 mb-1">
                      {title}
                    </h2>
                  </div>
                )}

                {/* Quick Facts Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-start gap-3 rounded-lg bg-gray-50 p-3">
                    <Calendar className="size-5 shrink-0 text-gray-600 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-600">Year Built</p>
                      <p className="font-medium text-gray-900">
                        {building.builtYear || "Unknown"}
                      </p>
                      {building.ageYears != null && (
                        <p className="text-xs text-gray-500">{building.ageYears} years old</p>
                      )}
                    </div>
                  </div>

                  {architects && (
                    <div className="flex items-start gap-3 rounded-lg bg-gray-50 p-3">
                      <User className="size-5 shrink-0 text-gray-600 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-600">Architect(s)</p>
                        <p className="font-medium text-gray-900">{architects}</p>
                      </div>
                    </div>
                  )}

                  {building.address && (
                    <div className="flex items-start gap-3 rounded-lg bg-gray-50 p-3 col-span-2">
                      <MapPin className="size-5 shrink-0 text-gray-600 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-600">Address</p>
                        <p className="font-medium text-gray-900 text-sm">
                          {building.addressRaw || building.address}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Description */}
                <div>
                  <h3 className="text-sm font-medium text-gray-900 mb-2">
                    Description
                  </h3>
                  <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">
                    {building.description || "No description yet."}
                  </p>
                </div>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
