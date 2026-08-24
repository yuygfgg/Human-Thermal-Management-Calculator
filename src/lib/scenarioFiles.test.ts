import { describe, expect, it } from "vitest";

import exportedScenarioFixture from "../../tests/fixtures/exported-scenario-v1.json";
import { BODY_SEGMENTS } from "../domain/types";
import type { SimulationResult, SimulationScenario } from "../domain/types";
import { ScenarioValidationError } from "../domain/scenario";
import {
  ScenarioJsonError,
  parseScenarioJson,
  serializeScenarioCsv,
  serializeScenarioJson,
} from "./scenarioFiles";

function scenario(): SimulationScenario {
  return {
    schemaVersion: 1,
    name: 'Commute "A", morning',
    subject: {
      sex: "male",
      heightCm: 180,
      weightKg: 75,
      ageYears: 35,
      referenceCoreTempC: 36.7,
    },
    stages: [{
      id: "walk",
      name: "Walk, outside",
      durationMin: 1,
      environment: {
        airTempC: { start: 10, end: 8 },
        windSpeedMs: { start: 1, end: 2 },
        relativeHumidityPercent: { start: 50, end: 60 },
        solarRadiationWm2: { start: 100, end: 200 },
        mediumThermalConductivityWmK: { start: 0.026, end: 0.026 },
      },
      activityMet: { start: 2, end: 3 },
      posture: "standing",
      outfit: [{
        id: "coat",
        instanceId: "coat-1",
        nameZh: "Coat",
        nameEn: "Coat",
        category: "outer",
        modifier: 1.25,
        segmentClo: { Chest: 0.5, Back: 0.5 },
      }],
    }],
  };
}

function result(): SimulationResult {
  const regionalRow = BODY_SEGMENTS.map((_, index) => index + 1);
  const matrix = [regionalRow, regionalRow];
  return {
    schemaVersion: 1,
    finalTemp: 36.8,
    coreTemp: 36.7,
    finalSkinTemp: 33,
    comfortScore: 90,
    vasoActive: false,
    dilateActive: false,
    shiverActive: false,
    sweatActive: false,
    finalState: {
      heatProductionWatts: 100,
      solarHeatGainWatts: 0,
      heatLossResp: 5,
      heatLossDry: 40,
      sweatingHeatLoss: 0,
      skinLatentHeatLoss: 0,
      netHeatRateWatts: 55,
      shiveringIntensity: 0,
      sweatingIntensity: 0,
      vasoconstrictionIntensity: 0,
      vasodilationIntensity: 0,
    },
    averages: {},
    dataHistory: {
      time: [0, 1],
      coreTemp: [36.7, 36.8],
      skinTemp: [33, 33],
      heatProduction: [100, 100],
      solarGain: [0, 0],
      respiratoryLoss: [5, 5],
      dryLoss: [40, 40],
      sweatLoss: [0, 0],
      skinLatentLoss: [0, 0],
      netRate: [55, 55],
      totalGain: [100, 100],
      totalLoss: [45, 45],
      shiveringIntensity: [0, 0],
      sweatingIntensity: [0, 0],
      vasoconstrictionIntensity: [0, 0],
      vasodilationIntensity: [0, 0],
      comfortScore: [90, 90],
      totalSkinLoss: [40, 40],
    },
    stageRanges: [{
      id: "walk",
      name: "Walk, outside",
      startMinute: 0,
      endMinute: 1,
      resultStartIndex: 1,
      resultEndIndex: 1,
    }],
    stageSummaries: [],
    regionalMetrics: {
      regionIds: [...BODY_SEGMENTS],
      units: {
        Tsk: "degC",
        Tcr: "degC",
        Wet: "fraction",
        BFsk: "L/h",
        Mshiv: "W",
        Esweat: "W",
        THLsk: "W",
        Icl: "clo",
      },
      Tsk: matrix,
      Tcr: matrix,
      Wet: matrix,
      BFsk: matrix,
      Mshiv: matrix,
      Esweat: matrix,
      THLsk: matrix,
      Icl: matrix,
    },
    jos3: { version: "0.5.0", results: {} },
  };
}

describe("scenario JSON", () => {
  it("accepts the shared version 1 export fixture", () => {
    expect(parseScenarioJson(JSON.stringify(exportedScenarioFixture))).toEqual(
      exportedScenarioFixture,
    );
  });

  it("round-trips the new scenario format", () => {
    const original = scenario();
    const source = serializeScenarioJson(original);

    expect(parseScenarioJson(source)).toEqual(original);
    expect(source.endsWith("\n")).toBe(true);
  });

  it("strictly rejects unknown schema versions", () => {
    const unknownSchema = { ...scenario(), schemaVersion: 2 };

    expect(() => parseScenarioJson(JSON.stringify(unknownSchema))).toThrow(ScenarioValidationError);
  });

  it("reports malformed JSON separately", () => {
    expect(() => parseScenarioJson("{")).toThrow(ScenarioJsonError);
  });
});

describe("scenario CSV", () => {
  it("exports only the new summary, stage, and clothing sections without a result", () => {
    const csv = serializeScenarioCsv(scenario());

    expect(csv).toContain("Scenario Summary\r\nfield,value");
    expect(csv).toContain("Stage Conditions");
    expect(csv).toContain("Clothing");
    expect(csv).not.toContain("Results (Long Format)");
    expect(csv).toContain('scenario_name,"Commute ""A"", morning"');
  });

  it("exports whole-body and regional results as a long table", () => {
    const csv = serializeScenarioCsv(scenario(), result());

    expect(csv).toContain("Results (Long Format)");
    expect(csv).toContain('0,walk,"Walk, outside",coreTemp,whole_body,36.7,degC');
    expect(csv).toContain('1,walk,"Walk, outside",Tsk,Head,1,degC');
    expect(csv).toContain('1,walk,"Walk, outside",Icl,RFoot,17,clo');
  });
});
