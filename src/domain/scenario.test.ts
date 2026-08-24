import { describe, expect, it } from "vitest";

import type { GarmentInstance, SimulationScenario } from "./types";
import {
  ScenarioValidationError,
  assertValidScenario,
  validateScenario,
} from "./scenario";

const shirt: GarmentInstance = {
  id: "shirt",
  instanceId: "shirt-1",
  nameZh: "Shirt",
  nameEn: "Shirt",
  category: "base",
  modifier: 1,
  segmentClo: { Chest: 0.2, Back: 0.2, Arm: 0.1 },
};

function scenario(): SimulationScenario {
  return {
    schemaVersion: 1,
    name: "Commute",
    subject: {
      sex: "female",
      heightCm: 165,
      weightKg: 55,
      ageYears: 30,
      referenceCoreTempC: 36.6,
    },
    stages: [
      {
        id: "indoors",
        name: "Indoors",
        durationMin: 30,
        environment: {
          airTempC: { start: 22, end: 22 },
          windSpeedMs: { start: 0.1, end: 0.1 },
          relativeHumidityPercent: { start: 50, end: 50 },
          solarRadiationWm2: { start: 0, end: 0 },
          mediumThermalConductivityWmK: { start: 0.026, end: 0.026 },
        },
        activityMet: { start: 1.2, end: 1.2 },
        posture: "sitting",
        outfit: [{ ...shirt, segmentClo: { ...shirt.segmentClo } }],
      },
    ],
  };
}

describe("validateScenario", () => {
  it("accepts a complete version 1 scenario", () => {
    expect(validateScenario(scenario())).toEqual([]);
  });

  it("returns paths for schema, profile, identity, and duration failures", () => {
    const invalid = scenario() as unknown as Record<string, unknown>;
    invalid.schemaVersion = 2;
    const stages = (invalid.stages as Array<Record<string, unknown>>);
    stages.push({ ...(stages[0]), id: "indoors", durationMin: 1411 });
    const firstEnvironment = stages[0].environment as Record<string, unknown>;
    firstEnvironment.relativeHumidityPercent = { start: -1, end: 101 };

    const paths = validateScenario(invalid).map((issue) => issue.path);

    expect(paths).toContain("schemaVersion");
    expect(paths).toContain("stages[0].environment.relativeHumidityPercent.start");
    expect(paths).toContain("stages[0].environment.relativeHumidityPercent.end");
    expect(paths).toContain("stages[1].id");
    expect(paths).toContain("stages");
  });

  it("validates subject and derived JOS-3 insulation boundaries", () => {
    const invalid = scenario();
    invalid.subject.heightCm = 99;
    invalid.stages[0].outfit[0].modifier = 3;
    invalid.stages[0].outfit[0].segmentClo.Chest = 10;
    invalid.stages[0].outfit[0].segmentClo.Back = 10;

    const issues = validateScenario(invalid);

    expect(issues).toContainEqual({
      path: "subject.heightCm",
      message: "Must be at least 100.",
    });
    expect(issues.some((issue) => issue.path.startsWith("stages[0].icl17["))).toBe(true);
  });

  it("rejects empty scenarios and non-finite numbers", () => {
    const invalid = scenario();
    invalid.stages = [];
    invalid.subject.weightKg = Number.NaN;

    expect(validateScenario(invalid)).toEqual(expect.arrayContaining([
      { path: "stages", message: "Must contain at least one stage." },
      { path: "subject.weightKg", message: "Must be a finite number." },
    ]));
  });

  it("accepts the exact 24-hour duration boundary", () => {
    const boundary = scenario();
    boundary.stages[0].durationMin = 1440;

    expect(validateScenario(boundary)).toEqual([]);
  });

  it("throws one structured error from the assertion API", () => {
    const invalid = scenario();
    invalid.stages[0].durationMin = 0;

    expect(() => assertValidScenario(invalid)).toThrow(ScenarioValidationError);
    try {
      assertValidScenario(invalid);
    } catch (error) {
      expect((error as ScenarioValidationError).issues[0].path).toBe("stages[0].durationMin");
    }
  });
});
