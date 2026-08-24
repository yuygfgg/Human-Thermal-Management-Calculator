import { calculateClothingInsulation, regionalCloToIcl17 } from "./clothing";
import scenarioContract from "../../scenario-contract.json";
import {
  BODY_SEGMENTS,
  CLOTHING_SEGMENTS,
  type ClothingCategory,
  type GarmentInstance,
  type ScalarProfile,
  type ScenarioValidationIssue,
  type SimulationScenario,
} from "./types";

interface NumericRange {
  minimum: number;
  maximum: number;
  integer?: boolean;
  exclusiveMinimum?: boolean;
}

export const SCENARIO_LIMITS = Object.freeze(
  scenarioContract.limits satisfies Record<string, NumericRange>,
);
export const MAX_SCENARIO_DURATION_MIN = SCENARIO_LIMITS.durationMin.maximum;

const CLOTHING_CATEGORIES = new Set<ClothingCategory>(
  scenarioContract.clothingCategories as ClothingCategory[],
);
const CLOTHING_SEGMENT_SET = new Set<string>(CLOTHING_SEGMENTS);
const POSTURES = new Set<string>(scenarioContract.postures);

export class ScenarioValidationError extends Error {
  readonly issues: ScenarioValidationIssue[];

  constructor(issues: ScenarioValidationIssue[]) {
    const firstIssue = issues[0];
    super(firstIssue ? `${firstIssue.path || "scenario"}: ${firstIssue.message}` : "Invalid scenario");
    this.name = "ScenarioValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ScenarioValidationIssue[],
  path: string,
  message: string,
): false {
  issues.push({ path, message });
  return false;
}

function validateNumber(
  value: unknown,
  path: string,
  range: NumericRange,
  issues: ScenarioValidationIssue[],
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return addIssue(issues, path, "Must be a finite number.");
  }
  if (range.integer && !Number.isInteger(value)) {
    return addIssue(issues, path, "Must be an integer.");
  }
  if (range.exclusiveMinimum ? value <= range.minimum : value < range.minimum) {
    const operator = range.exclusiveMinimum ? "greater than" : "at least";
    return addIssue(issues, path, `Must be ${operator} ${range.minimum}.`);
  }
  if (value > range.maximum) {
    return addIssue(issues, path, `Must be at most ${range.maximum}.`);
  }
  return true;
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: ScenarioValidationIssue[],
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return addIssue(issues, path, "Must be a non-empty string.");
  }
  return true;
}

function validateProfile(
  value: unknown,
  path: string,
  range: NumericRange,
  issues: ScenarioValidationIssue[],
): value is ScalarProfile {
  if (!isRecord(value)) {
    return addIssue(issues, path, "Must be a profile object with start and end values.");
  }
  const startValid = validateNumber(value.start, `${path}.start`, range, issues);
  const endValid = validateNumber(value.end, `${path}.end`, range, issues);
  return startValid && endValid;
}

function validateSubject(
  value: unknown,
  issues: ScenarioValidationIssue[],
): boolean {
  if (!isRecord(value)) {
    return addIssue(issues, "subject", "Must be an object.");
  }

  let valid = true;
  if (value.sex !== "male" && value.sex !== "female") {
    valid = addIssue(issues, "subject.sex", "Must be 'male' or 'female'.");
  }
  valid = validateNumber(
    value.heightCm,
    "subject.heightCm",
    SCENARIO_LIMITS.heightCm,
    issues,
  ) && valid;
  valid = validateNumber(
    value.weightKg,
    "subject.weightKg",
    SCENARIO_LIMITS.weightKg,
    issues,
  ) && valid;
  valid = validateNumber(
    value.ageYears,
    "subject.ageYears",
    SCENARIO_LIMITS.ageYears,
    issues,
  ) && valid;
  valid = validateNumber(
    value.referenceCoreTempC,
    "subject.referenceCoreTempC",
    SCENARIO_LIMITS.referenceCoreTempC,
    issues,
  ) && valid;
  return valid;
}

function validateSegmentClo(
  value: unknown,
  path: string,
  issues: ScenarioValidationIssue[],
): boolean {
  if (!isRecord(value)) {
    return addIssue(issues, path, "Must be an object.");
  }

  let valid = true;
  for (const [segment, clo] of Object.entries(value)) {
    if (!CLOTHING_SEGMENT_SET.has(segment)) {
      valid = addIssue(issues, `${path}.${segment}`, "Unknown clothing segment.");
      continue;
    }
    valid = validateNumber(clo, `${path}.${segment}`, SCENARIO_LIMITS.clothingClo, issues)
      && valid;
  }
  return valid;
}

function validateOutfit(
  value: unknown,
  path: string,
  issues: ScenarioValidationIssue[],
): value is GarmentInstance[] {
  if (!Array.isArray(value)) {
    return addIssue(issues, path, "Must be an array.");
  }

  let valid = true;
  const instanceIds = new Set<string>();
  value.forEach((garment, garmentIndex) => {
    const garmentPath = `${path}[${garmentIndex}]`;
    if (!isRecord(garment)) {
      valid = addIssue(issues, garmentPath, "Must be an object.");
      return;
    }

    valid = validateNonEmptyString(garment.id, `${garmentPath}.id`, issues) && valid;
    if (validateNonEmptyString(garment.instanceId, `${garmentPath}.instanceId`, issues)) {
      if (instanceIds.has(garment.instanceId)) {
        valid = addIssue(issues, `${garmentPath}.instanceId`, "Must be unique in the stage.");
      }
      instanceIds.add(garment.instanceId);
    } else {
      valid = false;
    }
    valid = validateNonEmptyString(garment.nameZh, `${garmentPath}.nameZh`, issues) && valid;
    valid = validateNonEmptyString(garment.nameEn, `${garmentPath}.nameEn`, issues) && valid;
    if (typeof garment.category !== "string"
      || !CLOTHING_CATEGORIES.has(garment.category as ClothingCategory)) {
      valid = addIssue(issues, `${garmentPath}.category`, "Unknown clothing category.");
    }
    valid = validateNumber(
      garment.modifier,
      `${garmentPath}.modifier`,
      SCENARIO_LIMITS.garmentModifier,
      issues,
    ) && valid;
    valid = validateSegmentClo(garment.segmentClo, `${garmentPath}.segmentClo`, issues)
      && valid;
  });

  return valid;
}

function validateEnvironment(
  value: unknown,
  path: string,
  issues: ScenarioValidationIssue[],
): boolean {
  if (!isRecord(value)) {
    return addIssue(issues, path, "Must be an object.");
  }

  let valid = true;
  valid = validateProfile(
    value.airTempC,
    `${path}.airTempC`,
    SCENARIO_LIMITS.airTempC,
    issues,
  ) && valid;
  valid = validateProfile(
    value.windSpeedMs,
    `${path}.windSpeedMs`,
    SCENARIO_LIMITS.windSpeedMs,
    issues,
  ) && valid;
  valid = validateProfile(
    value.relativeHumidityPercent,
    `${path}.relativeHumidityPercent`,
    SCENARIO_LIMITS.relativeHumidityPercent,
    issues,
  ) && valid;
  valid = validateProfile(
    value.solarRadiationWm2,
    `${path}.solarRadiationWm2`,
    SCENARIO_LIMITS.solarRadiationWm2,
    issues,
  ) && valid;
  valid = validateProfile(
    value.mediumThermalConductivityWmK,
    `${path}.mediumThermalConductivityWmK`,
    SCENARIO_LIMITS.mediumThermalConductivityWmK,
    issues,
  ) && valid;
  return valid;
}

function validateDerivedIcl17(
  outfit: GarmentInstance[],
  stagePath: string,
  issues: ScenarioValidationIssue[],
): boolean {
  const insulation = calculateClothingInsulation(outfit);
  const icl17 = regionalCloToIcl17(insulation.regionalClo);
  let valid = true;

  if (icl17.length !== BODY_SEGMENTS.length) {
    return addIssue(issues, `${stagePath}.icl17`, "Must contain exactly 17 JOS-3 nodes.");
  }
  icl17.forEach((value, index) => {
    valid = validateNumber(
      value,
      `${stagePath}.icl17[${index}]`,
      SCENARIO_LIMITS.clothingClo,
      issues,
    ) && valid;
  });
  return valid;
}

function validateStages(
  value: unknown,
  issues: ScenarioValidationIssue[],
): boolean {
  if (!Array.isArray(value)) {
    return addIssue(issues, "stages", "Must be an array.");
  }
  if (value.length === 0) {
    return addIssue(issues, "stages", "Must contain at least one stage.");
  }

  let valid = true;
  let totalDurationMin = 0;
  const stageIds = new Set<string>();
  value.forEach((stage, stageIndex) => {
    const stagePath = `stages[${stageIndex}]`;
    if (!isRecord(stage)) {
      valid = addIssue(issues, stagePath, "Must be an object.");
      return;
    }

    if (validateNonEmptyString(stage.id, `${stagePath}.id`, issues)) {
      if (stageIds.has(stage.id)) {
        valid = addIssue(issues, `${stagePath}.id`, "Must be unique in the scenario.");
      }
      stageIds.add(stage.id);
    } else {
      valid = false;
    }
    valid = validateNonEmptyString(stage.name, `${stagePath}.name`, issues) && valid;
    if (validateNumber(
      stage.durationMin,
      `${stagePath}.durationMin`,
      SCENARIO_LIMITS.durationMin,
      issues,
    )) {
      totalDurationMin += stage.durationMin;
    } else {
      valid = false;
    }
    valid = validateEnvironment(stage.environment, `${stagePath}.environment`, issues) && valid;
    valid = validateProfile(
      stage.activityMet,
      `${stagePath}.activityMet`,
      SCENARIO_LIMITS.activityMet,
      issues,
    ) && valid;
    if (typeof stage.posture !== "string" || !POSTURES.has(stage.posture)) {
      valid = addIssue(
        issues,
        `${stagePath}.posture`,
        "Must be 'standing', 'sitting', or 'lying'.",
      );
    }

    const issueCountBeforeOutfit = issues.length;
    const outfit = stage.outfit;
    const outfitValid = validateOutfit(outfit, `${stagePath}.outfit`, issues);
    if (outfitValid && issues.length === issueCountBeforeOutfit) {
      valid = validateDerivedIcl17(outfit, stagePath, issues) && valid;
    } else {
      valid = false;
    }
  });

  if (totalDurationMin > MAX_SCENARIO_DURATION_MIN) {
    valid = addIssue(
      issues,
      "stages",
      `Total duration must not exceed ${MAX_SCENARIO_DURATION_MIN} minutes.`,
    );
  }
  return valid;
}

/** Validate an untrusted scenario and return all actionable field issues. */
export function validateScenario(scenario: unknown): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  if (!isRecord(scenario)) {
    addIssue(issues, "", "Scenario must be an object.");
    return issues;
  }

  if (scenario.schemaVersion !== 1) {
    addIssue(issues, "schemaVersion", "Unsupported schema version. Expected 1.");
  }
  validateNonEmptyString(scenario.name, "name", issues);
  validateSubject(scenario.subject, issues);
  validateStages(scenario.stages, issues);
  return issues;
}

export function assertValidScenario(
  scenario: unknown,
): asserts scenario is SimulationScenario {
  const issues = validateScenario(scenario);
  if (issues.length > 0) {
    throw new ScenarioValidationError(issues);
  }
}
