import { promises as fs } from "node:fs";
import area from "@turf/area";

// Shared validation utilities for data processing pipeline

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  metrics?: Record<string, any>;
}

export interface ProcessingResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
  metrics: Record<string, any>;
}

// Zagreb city center coordinates for validation
const ZAGREB_CENTER = { lat: 45.8150, lon: 15.9819 };
const MAX_DISTANCE_FROM_ZAGREB_KM = 50; // Flag results >50km from Zagreb

/**
 * Calculate haversine distance between two points in meters
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Validate geocoding coordinates are reasonable for Zagreb
 */
export function validateCoordinates(lat: number | null, lon: number | null): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: []
  };

  if (lat === null || lon === null) {
    result.isValid = false;
    result.errors.push("Missing latitude or longitude");
    return result;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    result.isValid = false;
    result.errors.push("Invalid latitude or longitude values");
    return result;
  }

  // Check coordinate bounds (rough Croatia bounds)
  if (lat < 42.0 || lat > 47.0 || lon < 13.0 || lon > 19.5) {
    result.warnings.push(`Coordinates outside Croatia bounds: ${lat}, ${lon}`);
  }

  // Check distance from Zagreb center
  const distanceKm = haversineMeters(ZAGREB_CENTER.lat, ZAGREB_CENTER.lon, lat, lon) / 1000;
  if (distanceKm > MAX_DISTANCE_FROM_ZAGREB_KM) {
    result.warnings.push(`Coordinates ${distanceKm.toFixed(1)}km from Zagreb center (may be incorrect)`);
  }

  return result;
}

/**
 * Validate GeoJSON geometry
 */
export function validateGeometry(geom: GeoJSON.Geometry): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    metrics: {}
  };

  if (!geom || !geom.type) {
    result.isValid = false;
    result.errors.push("Missing or invalid geometry");
    return result;
  }

  if (!["Polygon", "MultiPolygon"].includes(geom.type)) {
    result.isValid = false;
    result.errors.push(`Unsupported geometry type: ${geom.type}`);
    return result;
  }

  // Use turf for accurate geodetic area calculation (returns m²)
  try {
    const areaM2 = area(geom);
    result.metrics!.area_sq_meters = areaM2;

    // Flag unrealistic building sizes
    if (areaM2 < 10) {
      result.warnings.push(`Very small geometry area: ${areaM2.toFixed(1)} m²`);
    } else if (areaM2 > 100000) {
      result.warnings.push(`Very large geometry area: ${(areaM2/1000).toFixed(1)} km² (may be incorrect)`);
    }
  } catch (e) {
    result.warnings.push("Could not calculate geometry area");
  }

  return result;
}

/**
 * Validate building record completeness (for canonical records with IDs)
 */
export function validateBuildingRecord(record: any): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: []
  };

  const requiredFields = ["id", "name", "address"];
  const recommendedFields = ["architects", "description"];

  for (const field of requiredFields) {
    if (!record[field] || String(record[field]).trim() === "") {
      result.isValid = false;
      result.errors.push(`Missing required field: ${field}`);
    }
  }

  for (const field of recommendedFields) {
    if (!record[field] || String(record[field]).trim() === "") {
      result.warnings.push(`Missing recommended field: ${field}`);
    }
  }

  return result;
}

/**
 * Validate raw building record (before ID generation)
 * Used during normalization when ID hasn't been created yet
 */
export function validateRawBuildingRecord(record: any): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: []
  };

  const requiredFields = ["name", "address"]; // No 'id' here - it's generated later
  const recommendedFields = ["architects", "description"];

  for (const field of requiredFields) {
    if (!record[field] || String(record[field]).trim() === "") {
      result.isValid = false;
      result.errors.push(`Missing required field: ${field}`);
    }
  }

  for (const field of recommendedFields) {
    if (!record[field] || String(record[field]).trim() === "") {
      result.warnings.push(`Missing recommended field: ${field}`);
    }
  }

  return result;
}

/**
 * Check for ID collisions in a dataset
 */
export function detectIdCollisions<T extends { id: string }>(records: T[]): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    metrics: { total_records: records.length }
  };

  const idCounts = new Map<string, T[]>();
  for (const record of records) {
    const existing = idCounts.get(record.id) || [];
    existing.push(record);
    idCounts.set(record.id, existing);
  }

  const collisions = Array.from(idCounts.entries())
    .filter(([, records]) => records.length > 1)
    .map(([id, records]) => ({
      id,
      count: records.length,
      records: records.map(r => ({ name: r.name || r.id, address: r.address }))
    }));

  if (collisions.length > 0) {
    result.isValid = false;
    result.errors.push(`Found ${collisions.length} ID collisions`);
    result.metrics!.collisions = collisions;
  }

  return result;
}

/**
 * Structured error handling wrapper for async functions
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: string
): Promise<ProcessingResult<T>> {
  try {
    const data = await operation();
    return {
      success: true,
      data,
      errors: [],
      warnings: [],
      metrics: {}
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${context} failed:`, errorMessage);

    return {
      success: false,
      errors: [`${context}: ${errorMessage}`],
      warnings: [],
      metrics: {}
    };
  }
}

/**
 * Write validation report to file
 */
export async function writeValidationReport(
  reportPath: string,
  results: ValidationResult[],
  context: string
): Promise<void> {
  const summary = {
    timestamp: new Date().toISOString(),
    context,
    total_checks: results.length,
    passed: results.filter(r => r.isValid).length,
    failed: results.filter(r => !r.isValid).length,
    total_errors: results.reduce((sum, r) => sum + r.errors.length, 0),
    total_warnings: results.reduce((sum, r) => sum + r.warnings.length, 0),
    details: results
  };

  await fs.mkdir(require("path").dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`📊 Validation report written to ${reportPath}`);
  console.log(`   ✅ ${summary.passed}/${summary.total_checks} checks passed`);
  if (summary.failed > 0) {
    console.log(`   ❌ ${summary.failed} checks failed`);
  }
  if (summary.total_warnings > 0) {
    console.log(`   ⚠️  ${summary.total_warnings} warnings`);
  }
}