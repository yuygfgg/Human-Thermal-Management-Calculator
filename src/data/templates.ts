import type {
  GarmentInstance,
  ScalarProfile,
  ScenarioStage,
  SimulationScenario,
} from "../domain/types";
import { createId } from "../lib/id";
import { CLOTHING_PRESET_BY_ID } from "./clothing";

export function constantProfile(value: number): ScalarProfile {
  return { start: value, end: value };
}

export function createGarment(presetId: string, modifier = 1): GarmentInstance {
  const preset = CLOTHING_PRESET_BY_ID.get(presetId);
  if (!preset) {
    throw new Error(`Unknown garment preset: ${presetId}`);
  }
  return {
    ...structuredClone(preset),
    instanceId: createId("garment"),
    modifier,
  };
}

function createStage(
  name: string,
  durationMin: number,
  airTempC: number,
  windSpeedMs: number,
  relativeHumidityPercent: number,
  solarRadiationWm2: number,
  activityMet: number,
  posture: ScenarioStage["posture"],
  outfit: GarmentInstance[],
): ScenarioStage {
  return {
    id: createId("stage"),
    name,
    durationMin,
    environment: {
      airTempC: constantProfile(airTempC),
      windSpeedMs: constantProfile(windSpeedMs),
      relativeHumidityPercent: constantProfile(relativeHumidityPercent),
      solarRadiationWm2: constantProfile(solarRadiationWm2),
      mediumThermalConductivityWmK: constantProfile(0.026),
    },
    activityMet: constantProfile(activityMet),
    posture,
    outfit: structuredClone(outfit),
  };
}

function baseScenario(name: string, stages: ScenarioStage[]): SimulationScenario {
  return {
    schemaVersion: 1,
    name,
    subject: {
      sex: "female",
      heightCm: 165,
      weightKg: 55,
      ageYears: 28,
      referenceCoreTempC: 36.8,
    },
    stages,
  };
}

export function createWinterCommuteScenario(): SimulationScenario {
  const indoorOutfit = [
    createGarment("base_underwear"),
    createGarment("base_thermal_long"),
    createGarment("mid_sweater"),
    createGarment("pants_jeans"),
    createGarment("acc_crew_socks"),
    createGarment("acc_shoes"),
  ];
  const outdoorOutfit = [
    ...structuredClone(indoorOutfit),
    createGarment("outer_down_jacket"),
    createGarment("acc_gloves"),
    createGarment("acc_beanie"),
    createGarment("acc_scarf"),
  ];

  return baseScenario("Winter commute", [
    createStage("Indoor preparation", 15, 21, 0.1, 42, 0, 1.2, "sitting", indoorOutfit),
    createStage("Outdoor walk", 30, 5, 4.2, 55, 350, 2.6, "standing", outdoorOutfit),
    createStage("Indoor recovery", 20, 22, 0.1, 42, 0, 1.2, "sitting", indoorOutfit),
  ]);
}

export function createExerciseRecoveryScenario(): SimulationScenario {
  const trainingOutfit = [
    createGarment("base_sports_bra"),
    createGarment("base_synthetic_tshirt"),
    createGarment("pants_shorts"),
    createGarment("acc_ankle_socks"),
    createGarment("acc_shoes"),
  ];

  return baseScenario("Exercise and recovery", [
    createStage("Warm-up", 10, 20, 0.2, 45, 0, 2, "standing", trainingOutfit),
    {
      ...createStage("Progressive run", 25, 18, 1.2, 48, 0, 5, "standing", trainingOutfit),
      activityMet: { start: 5, end: 8 },
    },
    createStage("Cool-down", 20, 20, 0.2, 45, 0, 1.5, "standing", trainingOutfit),
  ]);
}

export function createSingleStageScenario(): SimulationScenario {
  const outfit = [
    createGarment("base_t_shirt"),
    createGarment("pants_trousers"),
    createGarment("acc_crew_socks"),
    createGarment("acc_shoes"),
  ];

  return baseScenario("Single exposure", [
    createStage("Office", 30, 23, 0.1, 50, 0, 1.2, "sitting", outfit),
  ]);
}

export const SCENARIO_TEMPLATES = [
  { id: "winter-commute", label: { zh: "冬季通勤", en: "Winter commute" }, create: createWinterCommuteScenario },
  { id: "exercise-recovery", label: { zh: "运动与恢复", en: "Exercise and recovery" }, create: createExerciseRecoveryScenario },
  { id: "single-stage", label: { zh: "单阶段", en: "Single stage" }, create: createSingleStageScenario },
] as const;
