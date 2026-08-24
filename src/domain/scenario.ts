import { calculateClothingInsulation, regionalCloToIcl17 } from "./clothing";
import {
  MAX_SCENARIO_DURATION_MIN,
  SCENARIO_LIMITS,
  clothingCloIssue,
  isValidDuration,
  isValidOutfitStructure,
  validateScenarioStructure,
} from "./scenarioContract";
import type {
  GarmentInstance,
  ScenarioValidationIssue,
  SimulationScenario,
} from "./types";

export { MAX_SCENARIO_DURATION_MIN, SCENARIO_LIMITS } from "./scenarioContract";

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && /\S/.test(value);
}

function addSemanticIssues(
  scenario: unknown,
  issues: ScenarioValidationIssue[],
): void {
  if (!isRecord(scenario) || !Array.isArray(scenario.stages)) return;

  let totalDurationMin = 0;
  const stageIds = new Set<string>();

  scenario.stages.forEach((stage, stageIndex) => {
    if (!isRecord(stage)) return;
    const stagePath = `stages[${stageIndex}]`;

    if (isNonEmptyString(stage.id)) {
      if (stageIds.has(stage.id)) {
        issues.push({ path: `${stagePath}.id`, message: "Must be unique in the scenario." });
      }
      stageIds.add(stage.id);
    }

    if (isValidDuration(stage.durationMin)) {
      totalDurationMin += stage.durationMin;
    }

    if (!isValidOutfitStructure(stage.outfit)) return;
    const outfit = stage.outfit as GarmentInstance[];
    const instanceIds = new Set<string>();
    outfit.forEach((garment, garmentIndex) => {
      if (instanceIds.has(garment.instanceId)) {
        issues.push({
          path: `${stagePath}.outfit[${garmentIndex}].instanceId`,
          message: "Must be unique in the stage.",
        });
      }
      instanceIds.add(garment.instanceId);
    });

    const insulation = calculateClothingInsulation(outfit);
    const icl17 = regionalCloToIcl17(insulation.regionalClo);
    icl17.forEach((value, index) => {
      const issue = clothingCloIssue(value);
      if (issue) {
        issues.push({ path: `${stagePath}.icl17[${index}]`, message: issue.message });
      }
    });
  });

  if (totalDurationMin > MAX_SCENARIO_DURATION_MIN) {
    issues.push({
      path: "stages",
      message: `Total duration must not exceed ${MAX_SCENARIO_DURATION_MIN} minutes.`,
    });
  }
}

/** Validate an untrusted scenario against the shared version 1 contract. */
export function validateScenario(scenario: unknown): ScenarioValidationIssue[] {
  const issues = validateScenarioStructure(scenario);
  addSemanticIssues(scenario, issues);
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
