import clothingCatalog from "../../clothing-catalog.json";
import { validateGarmentCatalog } from "../domain/scenarioContract";
import type { GarmentPreset } from "../domain/types";

const catalogIssues = validateGarmentCatalog(clothingCatalog);
if (catalogIssues.length > 0) {
  const issue = catalogIssues[0];
  throw new Error(`Invalid clothing catalog at ${issue.path || "catalog"}: ${issue.message}`);
}

export const CLOTHING_PRESETS = clothingCatalog as GarmentPreset[];

export const CLOTHING_PRESET_BY_ID = new Map(
  CLOTHING_PRESETS.map((preset) => [preset.id, preset]),
);
