import { BODY_SEGMENTS, CLOTHING_SEGMENTS } from "../domain/types";
import type {
  ClothingSegment,
  DataHistory,
  RegionalMetricKey,
  SimulationResult,
  SimulationScenario,
  StageRange,
} from "../domain/types";
import { calculateClothingInsulation } from "../domain/clothing";
import { assertValidScenario } from "../domain/scenario";

export class ScenarioJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioJsonError";
  }
}

/** Serialize one validated version 1 scenario. */
export function serializeScenarioJson(scenario: SimulationScenario): string {
  assertValidScenario(scenario);
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

/** Parse and validate a scenario. Unknown schema versions are rejected. */
export function parseScenarioJson(source: string): SimulationScenario {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ScenarioJsonError("The file is not valid JSON.");
  }
  assertValidScenario(value);
  return value;
}

export const exportScenarioJson = serializeScenarioJson;
export const importScenarioJson = parseScenarioJson;

type CsvValue = string | number | boolean | null | undefined;

const HISTORY_UNITS: Readonly<Record<string, string>> = {
  coreTemp: "degC",
  skinTemp: "degC",
  heatProduction: "W",
  solarGain: "W",
  respiratoryLoss: "W",
  dryLoss: "W",
  sweatLoss: "W",
  skinLatentLoss: "W",
  netRate: "W",
  totalGain: "W",
  totalLoss: "W",
  shiveringIntensity: "percent",
  sweatingIntensity: "percent",
  vasoconstrictionIntensity: "percent",
  vasodilationIntensity: "percent",
  comfortScore: "score",
  totalSkinLoss: "W",
  airTemp: "degC",
  radiantTemp: "degC",
  relativeHumidity: "percent",
  airSpeed: "m/s",
  solarRadiation: "W/m2",
  mediumThermalConductivity: "W/(m*K)",
  mediumHcScale: "ratio",
  activityMet: "met",
  shiveringActivityScale: "ratio",
  shiveringSuppressionCoeff: "ratio",
  shiveringWorkWatts: "W",
  shiveringTemperatureScale: "ratio",
  shiveringFatigueScale: "ratio",
  effectiveShiveringScale: "ratio",
};

const NON_METRIC_HISTORY_KEYS = new Set(["time", "stageId", "stageName", "posture", "icl17"]);
const REGIONAL_KEYS: RegionalMetricKey[] = [
  "Tsk",
  "Tcr",
  "Wet",
  "BFsk",
  "Mshiv",
  "Esweat",
  "THLsk",
  "Icl",
];

function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(",");
}

function addSection(
  rows: string[],
  title: string,
  header: readonly string[],
  dataRows: readonly CsvValue[][],
): void {
  if (rows.length > 0) {
    rows.push("");
  }
  rows.push(csvRow([title]));
  rows.push(csvRow(header));
  for (const row of dataRows) {
    rows.push(csvRow(row));
  }
}

function scenarioSummaryRows(scenario: SimulationScenario): CsvValue[][] {
  return [
    ["schema_version", scenario.schemaVersion],
    ["scenario_name", scenario.name],
    ["total_duration_min", scenario.stages.reduce((sum, stage) => sum + stage.durationMin, 0)],
    ["subject.sex", scenario.subject.sex],
    ["subject.height_cm", scenario.subject.heightCm],
    ["subject.weight_kg", scenario.subject.weightKg],
    ["subject.age_years", scenario.subject.ageYears],
    ["subject.reference_core_temp_c", scenario.subject.referenceCoreTempC],
  ];
}

function stageConditionRows(scenario: SimulationScenario): CsvValue[][] {
  let startMinute = 0;
  return scenario.stages.map((stage, index) => {
    const endMinute = startMinute + stage.durationMin;
    const insulation = calculateClothingInsulation(stage.outfit);
    const row: CsvValue[] = [
      index + 1,
      stage.id,
      stage.name,
      startMinute,
      endMinute,
      stage.durationMin,
      stage.posture,
      stage.activityMet.start,
      stage.activityMet.end,
      stage.environment.airTempC.start,
      stage.environment.airTempC.end,
      stage.environment.windSpeedMs.start,
      stage.environment.windSpeedMs.end,
      stage.environment.relativeHumidityPercent.start,
      stage.environment.relativeHumidityPercent.end,
      stage.environment.solarRadiationWm2.start,
      stage.environment.solarRadiationWm2.end,
      stage.environment.mediumThermalConductivityWmK.start,
      stage.environment.mediumThermalConductivityWmK.end,
      insulation.garmentInsulationSumClo,
      insulation.ensembleInsulationClo,
    ];
    startMinute = endMinute;
    return row;
  });
}

function clothingRows(scenario: SimulationScenario): CsvValue[][] {
  const rows: CsvValue[][] = [];
  scenario.stages.forEach((stage, stageIndex) => {
    stage.outfit.forEach((garment, garmentIndex) => {
      const segments = CLOTHING_SEGMENTS.filter(
        (segment) => garment.segmentClo[segment] !== undefined,
      );
      const exportedSegments: Array<ClothingSegment | null> = segments.length > 0
        ? segments
        : [null];

      for (const segment of exportedSegments) {
        rows.push([
          stageIndex + 1,
          stage.id,
          garmentIndex + 1,
          garment.instanceId,
          garment.id,
          garment.nameEn,
          garment.nameZh,
          garment.category,
          garment.modifier,
          segment,
          segment === null ? null : garment.segmentClo[segment],
        ]);
      }
    });
  });
  return rows;
}

function rangeContainsIndex(range: StageRange, index: number): boolean {
  return index >= range.resultStartIndex && index <= range.resultEndIndex;
}

function stageAtResultIndex(
  scenario: SimulationScenario,
  result: SimulationResult,
  index: number,
): { id: string; name: string } {
  if (index === 0) {
    return scenario.stages[0];
  }
  const range = result.stageRanges.find((candidate) => rangeContainsIndex(candidate, index));
  if (range) {
    return range;
  }

  let endMinute = 0;
  for (const stage of scenario.stages) {
    endMinute += stage.durationMin;
    if (index <= endMinute) {
      return stage;
    }
  }
  return scenario.stages.at(-1) ?? { id: "", name: "" };
}

function numericHistorySeries(history: DataHistory): Array<[string, number[]]> {
  const entries = Object.entries(history as unknown as Record<string, unknown>);
  return entries.flatMap(([metric, value]) => {
    if (NON_METRIC_HISTORY_KEYS.has(metric) || !Array.isArray(value)) {
      return [];
    }
    if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return [];
    }
    return [[metric, value as number[]] as [string, number[]]];
  });
}

function resultRows(
  scenario: SimulationScenario,
  result: SimulationResult,
): CsvValue[][] {
  const rows: CsvValue[][] = [];
  const times = result.dataHistory.time;

  for (const [metric, series] of numericHistorySeries(result.dataHistory)) {
    const rowCount = Math.min(times.length, series.length);
    for (let index = 0; index < rowCount; index += 1) {
      const stage = stageAtResultIndex(scenario, result, index);
      rows.push([
        times[index],
        stage.id,
        stage.name,
        metric,
        "whole_body",
        series[index],
        HISTORY_UNITS[metric] ?? "",
      ]);
    }
  }

  for (const metric of REGIONAL_KEYS) {
    const matrix = result.regionalMetrics[metric];
    const unit = result.regionalMetrics.units[metric] ?? "";
    const rowCount = Math.min(times.length, matrix.length);
    for (let timeIndex = 0; timeIndex < rowCount; timeIndex += 1) {
      const stage = stageAtResultIndex(scenario, result, timeIndex);
      const regionCount = Math.min(
        BODY_SEGMENTS.length,
        result.regionalMetrics.regionIds.length,
        matrix[timeIndex].length,
      );
      for (let regionIndex = 0; regionIndex < regionCount; regionIndex += 1) {
        rows.push([
          times[timeIndex],
          stage.id,
          stage.name,
          metric,
          result.regionalMetrics.regionIds[regionIndex],
          matrix[timeIndex][regionIndex],
          unit,
        ]);
      }
    }
  }
  return rows;
}

/**
 * Export the new scenario CSV format.
 *
 * The CSV contains independent summary, stage, clothing, and optional result
 * sections. Result values use a long table for direct filtering and analysis.
 * CSV import is intentionally not supported.
 */
export function serializeScenarioCsv(
  scenario: SimulationScenario,
  result?: SimulationResult | null,
): string {
  assertValidScenario(scenario);
  const rows: string[] = [];

  addSection(rows, "Scenario Summary", ["field", "value"], scenarioSummaryRows(scenario));
  addSection(rows, "Stage Conditions", [
    "stage_number",
    "stage_id",
    "stage_name",
    "start_min",
    "end_min",
    "duration_min",
    "posture",
    "activity_met_start",
    "activity_met_end",
    "air_temp_c_start",
    "air_temp_c_end",
    "wind_speed_ms_start",
    "wind_speed_ms_end",
    "relative_humidity_percent_start",
    "relative_humidity_percent_end",
    "solar_radiation_wm2_start",
    "solar_radiation_wm2_end",
    "medium_thermal_conductivity_wmk_start",
    "medium_thermal_conductivity_wmk_end",
    "garment_insulation_sum_clo",
    "iso_9920_ensemble_clo",
  ], stageConditionRows(scenario));
  addSection(rows, "Clothing", [
    "stage_number",
    "stage_id",
    "garment_number",
    "instance_id",
    "garment_id",
    "name_en",
    "name_zh",
    "category",
    "modifier",
    "segment",
    "segment_clo",
  ], clothingRows(scenario));

  if (result) {
    addSection(rows, "Results (Long Format)", [
      "time_min",
      "stage_id",
      "stage_name",
      "metric",
      "region",
      "value",
      "unit",
    ], resultRows(scenario, result));
  }

  return `${rows.join("\r\n")}\r\n`;
}

export const exportScenarioCsv = serializeScenarioCsv;
