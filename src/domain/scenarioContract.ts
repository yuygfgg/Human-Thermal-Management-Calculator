import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

import scenarioContract from "../../scenario-contract.json";
import type { ScenarioValidationIssue } from "./types";

interface NumericRange {
  type: "integer" | "number";
  minimum?: number;
  exclusiveMinimum?: number;
  maximum: number;
}

const limitDefinitions = scenarioContract.definitions;

export const SCENARIO_LIMITS = Object.freeze({
  heightCm: limitDefinitions.heightCm,
  weightKg: limitDefinitions.weightKg,
  ageYears: limitDefinitions.ageYears,
  referenceCoreTempC: limitDefinitions.referenceCoreTempC,
  durationMin: limitDefinitions.durationMin,
  airTempC: limitDefinitions.airTempC,
  windSpeedMs: limitDefinitions.windSpeedMs,
  relativeHumidityPercent: limitDefinitions.relativeHumidityPercent,
  solarRadiationWm2: limitDefinitions.solarRadiationWm2,
  mediumThermalConductivityWmK: limitDefinitions.mediumThermalConductivityWmK,
  activityMet: limitDefinitions.activityMet,
  garmentModifier: limitDefinitions.garmentModifier,
  clothingClo: limitDefinitions.clothingClo,
}) as Readonly<Record<string, NumericRange>>;

export const MAX_SCENARIO_DURATION_MIN = SCENARIO_LIMITS.durationMin.maximum;

const schemaId = scenarioContract.$id;
const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true });
ajv.addSchema(scenarioContract, schemaId);

function referencedValidator(reference: string): ValidateFunction {
  return ajv.compile({ $ref: `${schemaId}#/definitions/${reference}` });
}

const scenarioValidator = ajv.getSchema(schemaId) as ValidateFunction;
const outfitValidator = ajv.compile({
  type: "array",
  items: { $ref: `${schemaId}#/definitions/garment` },
});
const durationValidator = referencedValidator("durationMin");
const clothingCloValidator = referencedValidator("clothingClo");
const garmentCatalogValidator = ajv.compile({
  type: "array",
  minItems: 1,
  items: { $ref: `${schemaId}#/definitions/garmentPreset` },
});

function decodePointerPart(part: string): string {
  return part.replaceAll("~1", "/").replaceAll("~0", "~");
}

function appendPath(path: string, property: string): string {
  if (/^(0|[1-9]\d*)$/.test(property)) {
    return `${path}[${property}]`;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(property)) {
    return path ? `${path}.${property}` : property;
  }
  return `${path}[${JSON.stringify(property)}]`;
}

function pointerToPath(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map(decodePointerPart)
    .reduce(appendPath, "");
}

function schemaErrorPath(error: ErrorObject): string {
  let path = pointerToPath(error.instancePath);
  if (error.keyword === "required") {
    path = appendPath(path, String(error.params.missingProperty));
  } else if (error.keyword === "additionalProperties") {
    path = appendPath(path, String(error.params.additionalProperty));
  } else if (error.keyword === "propertyNames") {
    path = appendPath(path, String(error.params.propertyName));
  }
  return path;
}

function schemaErrorMessage(error: ErrorObject, path: string): string | null {
  if (error.propertyName && error.keyword === "enum") {
    return null;
  }

  switch (error.keyword) {
    case "required":
      return "Is required.";
    case "additionalProperties":
      return "Unknown property.";
    case "propertyNames":
      return path.includes(".segmentClo.") ? "Unknown clothing segment." : "Unknown property.";
    case "const":
      return path === "schemaVersion"
        ? `Unsupported schema version. Expected ${String(error.params.allowedValue)}.`
        : `Must equal ${String(error.params.allowedValue)}.`;
    case "type": {
      const expected = String(error.params.type);
      if (expected === "number") return "Must be a finite number.";
      if (expected === "integer") return "Must be an integer.";
      return `Must be ${expected === "array" ? "an" : "a"} ${expected}.`;
    }
    case "pattern":
      return "Must be a non-empty string.";
    case "enum": {
      if (path.endsWith(".category")) return "Unknown clothing category.";
      if (path.endsWith(".posture")) return "Must be 'standing', 'sitting', or 'lying'.";
      if (path === "subject.sex") return "Must be 'female' or 'male'.";
      return `Must be one of: ${(error.params.allowedValues as unknown[]).join(", ")}.`;
    }
    case "minimum":
      return `Must be at least ${String(error.params.limit)}.`;
    case "exclusiveMinimum":
      return `Must be greater than ${String(error.params.limit)}.`;
    case "maximum":
      return `Must be at most ${String(error.params.limit)}.`;
    case "minItems":
      return path === "stages"
        ? "Must contain at least one stage."
        : `Must contain at least ${String(error.params.limit)} items.`;
    default: {
      const message = error.message ?? "Is invalid.";
      return `${message.charAt(0).toUpperCase()}${message.slice(1)}${message.endsWith(".") ? "" : "."}`;
    }
  }
}

function normalizedErrors(errors: ErrorObject[] | null | undefined): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  const seen = new Set<string>();

  for (const error of errors ?? []) {
    const path = schemaErrorPath(error);
    const message = schemaErrorMessage(error, path);
    if (!message) continue;

    const key = `${path}\u0000${message}`;
    if (!seen.has(key)) {
      issues.push({ path, message });
      seen.add(key);
    }
  }
  return issues;
}

export function validateScenarioStructure(value: unknown): ScenarioValidationIssue[] {
  scenarioValidator(value);
  return normalizedErrors(scenarioValidator.errors);
}

export function isValidOutfitStructure(value: unknown): boolean {
  return outfitValidator(value);
}

export function isValidDuration(value: unknown): value is number {
  return durationValidator(value);
}

export function clothingCloIssue(value: unknown): ScenarioValidationIssue | null {
  if (clothingCloValidator(value)) return null;
  return normalizedErrors(clothingCloValidator.errors)[0] ?? {
    path: "",
    message: "Must be valid regional clothing insulation.",
  };
}

export function validateGarmentCatalog(value: unknown): ScenarioValidationIssue[] {
  garmentCatalogValidator(value);
  const issues = normalizedErrors(garmentCatalogValidator.errors);
  if (!Array.isArray(value)) return issues;

  const seenIds = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "object" || item === null || !("id" in item)) return;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/\S/.test(id)) return;
    if (seenIds.has(id)) {
      issues.push({ path: `[${index}].id`, message: "Must be unique in the catalog." });
    }
    seenIds.add(id);
  });
  return issues;
}
