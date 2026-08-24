export const BODY_SEGMENTS = [
  "Head",
  "Neck",
  "Chest",
  "Back",
  "Pelvis",
  "LShoulder",
  "LArm",
  "LHand",
  "RShoulder",
  "RArm",
  "RHand",
  "LThigh",
  "LLeg",
  "LFoot",
  "RThigh",
  "RLeg",
  "RFoot",
] as const;

export type BodySegment = (typeof BODY_SEGMENTS)[number];

export const CLOTHING_SEGMENTS = [
  "Head",
  "Neck",
  "Chest",
  "Back",
  "Pelvis",
  "Shoulder",
  "Arm",
  "Hand",
  "Thigh",
  "Leg",
  "Foot",
] as const;

export type ClothingSegment = (typeof CLOTHING_SEGMENTS)[number];
export type Language = "zh" | "en";
export type Theme = "light" | "dark";
export type Posture = "standing" | "sitting" | "lying";

export interface ScalarProfile {
  start: number;
  end: number;
}

export interface Subject {
  sex: "male" | "female";
  heightCm: number;
  weightKg: number;
  ageYears: number;
  referenceCoreTempC: number;
}

export interface EnvironmentProfile {
  airTempC: ScalarProfile;
  windSpeedMs: ScalarProfile;
  relativeHumidityPercent: ScalarProfile;
  solarRadiationWm2: ScalarProfile;
  mediumThermalConductivityWmK: ScalarProfile;
}

export type ClothingCategory =
  | "base"
  | "mid"
  | "outer"
  | "bottoms"
  | "full"
  | "accessories";

export interface GarmentPreset {
  id: string;
  nameZh: string;
  nameEn: string;
  category: ClothingCategory;
  segmentClo: Partial<Record<ClothingSegment, number>>;
}

export interface GarmentInstance extends GarmentPreset {
  instanceId: string;
  modifier: number;
}

export interface ScenarioStage {
  id: string;
  name: string;
  durationMin: number;
  environment: EnvironmentProfile;
  activityMet: ScalarProfile;
  posture: Posture;
  outfit: GarmentInstance[];
}

export interface SimulationScenario {
  schemaVersion: 1;
  name: string;
  subject: Subject;
  stages: ScenarioStage[];
}

export interface StageRange {
  id: string;
  name: string;
  startMinute: number;
  endMinute: number;
  resultStartIndex: number;
  resultEndIndex: number;
}

export type RegionalMetricKey =
  | "Tsk"
  | "Tcr"
  | "Wet"
  | "BFsk"
  | "Mshiv"
  | "Esweat"
  | "THLsk"
  | "Icl";

export interface RegionalMetrics {
  regionIds: BodySegment[];
  jos3RegionSuffixes?: BodySegment[];
  units: Record<RegionalMetricKey, string>;
  Tsk: number[][];
  Tcr: number[][];
  Wet: number[][];
  BFsk: number[][];
  Mshiv: number[][];
  Esweat: number[][];
  THLsk: number[][];
  Icl: number[][];
}

export interface DataHistory {
  time: number[];
  coreTemp: number[];
  skinTemp: number[];
  heatProduction: number[];
  solarGain: number[];
  respiratoryLoss: number[];
  dryLoss: number[];
  sweatLoss: number[];
  skinLatentLoss: number[];
  netRate: number[];
  totalGain: number[];
  totalLoss: number[];
  shiveringIntensity: number[];
  sweatingIntensity: number[];
  vasoconstrictionIntensity: number[];
  vasodilationIntensity: number[];
  comfortScore: number[];
  instantComfortScore?: number[];
  totalSkinLoss: number[];
  stageId?: string[];
  stageName?: string[];
  posture?: Posture[];
  airTemp?: number[];
  radiantTemp?: number[];
  relativeHumidity?: number[];
  airSpeed?: number[];
  solarRadiation?: number[];
  mediumThermalConductivity?: number[];
  activityMet?: number[];
  icl17?: number[][];
}

export interface SimulationSummaryValues {
  heatProductionWatts: number;
  solarHeatGainWatts: number;
  heatLossResp: number;
  heatLossDry: number;
  sweatingHeatLoss: number;
  skinLatentHeatLoss: number;
  netHeatRateWatts: number;
  shiveringIntensity: number;
  sweatingIntensity: number;
  vasoconstrictionIntensity: number;
  vasodilationIntensity: number;
}

export interface StageSummary {
  id: string;
  name: string;
  stageIndex: number;
  startMinute: number;
  endMinute: number;
  durationMin: number;
  resultStartIndex: number;
  resultEndIndex: number;
  sampleCount: number;
  averages: {
    coreTempC: number;
    skinTempC: number;
    netRateW: number;
    comfortScore: number;
  };
  extrema: {
    coreTempMinC: number;
    coreTempMaxC: number;
    skinTempMinC: number;
    skinTempMaxC: number;
  };
  final: {
    timeMin: number;
    coreTempC: number;
    skinTempC: number;
    netRateW: number;
    comfortScore: number;
  };
}

export interface SimulationResult {
  schemaVersion?: number;
  finalTemp: number;
  coreTemp: number;
  finalSkinTemp: number;
  comfortScore: number;
  vasoActive: boolean;
  dilateActive: boolean;
  shiverActive: boolean;
  sweatActive: boolean;
  finalState: SimulationSummaryValues & Record<string, number>;
  averages: Record<string, number>;
  dataHistory: DataHistory;
  stageRanges: StageRange[];
  stageSummaries: StageSummary[];
  regionalMetrics: RegionalMetrics;
  jos3: {
    version: string | null;
    results: Record<string, Array<number | null | string>>;
  };
}

export interface ScenarioValidationIssue {
  path: string;
  message: string;
}
