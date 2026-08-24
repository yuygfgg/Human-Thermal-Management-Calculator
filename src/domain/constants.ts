import type {
  BodySegment,
  ClothingCategory,
  Language,
  Posture,
  RegionalMetricKey,
} from "./types";

export const SEGMENT_LABELS: Record<BodySegment, Record<Language, string>> = {
  Head: { zh: "头部", en: "Head" },
  Neck: { zh: "颈部", en: "Neck" },
  Chest: { zh: "胸部", en: "Chest" },
  Back: { zh: "背部", en: "Back" },
  Pelvis: { zh: "骨盆", en: "Pelvis" },
  LShoulder: { zh: "左肩", en: "Left shoulder" },
  LArm: { zh: "左臂", en: "Left arm" },
  LHand: { zh: "左手", en: "Left hand" },
  RShoulder: { zh: "右肩", en: "Right shoulder" },
  RArm: { zh: "右臂", en: "Right arm" },
  RHand: { zh: "右手", en: "Right hand" },
  LThigh: { zh: "左大腿", en: "Left thigh" },
  LLeg: { zh: "左小腿", en: "Left lower leg" },
  LFoot: { zh: "左脚", en: "Left foot" },
  RThigh: { zh: "右大腿", en: "Right thigh" },
  RLeg: { zh: "右小腿", en: "Right lower leg" },
  RFoot: { zh: "右脚", en: "Right foot" },
};

export const CATEGORY_LABELS: Record<ClothingCategory, Record<Language, string>> = {
  base: { zh: "贴身层", en: "Base layer" },
  mid: { zh: "中间层", en: "Mid layer" },
  outer: { zh: "外层", en: "Outer layer" },
  bottoms: { zh: "下装", en: "Bottoms" },
  full: { zh: "全身", en: "Full body" },
  accessories: { zh: "配饰", en: "Accessories" },
};

export const POSTURE_LABELS: Record<Posture, Record<Language, string>> = {
  standing: { zh: "站立", en: "Standing" },
  sitting: { zh: "坐姿", en: "Sitting" },
  lying: { zh: "卧姿", en: "Lying" },
};

export interface ActivityPreset {
  id: string;
  met: number;
  posture: Posture;
  label: Record<Language, string>;
}

export const ACTIVITY_PRESETS: ActivityPreset[] = [
  { id: "sleeping", met: 1.0, posture: "lying", label: { zh: "睡眠", en: "Sleeping" } },
  { id: "seated", met: 1.0, posture: "sitting", label: { zh: "安静坐姿", en: "Seated, quiet" } },
  { id: "office", met: 1.2, posture: "sitting", label: { zh: "办公室工作", en: "Office work" } },
  { id: "standing", met: 1.2, posture: "standing", label: { zh: "放松站立", en: "Standing, relaxed" } },
  { id: "cooking", met: 1.8, posture: "standing", label: { zh: "做饭", en: "Cooking" } },
  { id: "slow-walk", met: 2.0, posture: "standing", label: { zh: "悠闲步行", en: "Leisurely walk" } },
  { id: "walk", met: 2.6, posture: "standing", label: { zh: "正常步行", en: "Normal walk" } },
  { id: "brisk-walk", met: 3.8, posture: "standing", label: { zh: "快速步行", en: "Brisk walk" } },
  { id: "jogging", met: 6.0, posture: "standing", label: { zh: "慢跑", en: "Jogging" } },
  { id: "running", met: 8.0, posture: "standing", label: { zh: "跑步", en: "Running" } },
  { id: "vigorous", met: 10.0, posture: "standing", label: { zh: "剧烈运动", en: "Vigorous exercise" } },
];

export interface SolarRadiationPreset {
  id: string;
  valueWm2: number;
  label: Record<Language, string>;
}

export const SOLAR_RADIATION_PRESETS: SolarRadiationPreset[] = [
  { id: "shade", valueWm2: 0, label: { zh: "遮阴 / 无日照", en: "Shade / no sun" } },
  { id: "overcast", valueWm2: 200, label: { zh: "阴天", en: "Overcast" } },
  { id: "cloudy", valueWm2: 400, label: { zh: "多云", en: "Cloudy" } },
  { id: "sunny", valueWm2: 600, label: { zh: "晴天", en: "Sunny" } },
  { id: "intense-sun", valueWm2: 800, label: { zh: "强烈日照", en: "Intense sun" } },
];

export interface MetricDefinition {
  key: RegionalMetricKey;
  label: Record<Language, string>;
  shortLabel: string;
  domain?: readonly [number, number];
  decimals: number;
  palette: "thermal" | "sequential" | "diverging";
}

export const REGIONAL_METRICS: MetricDefinition[] = [
  { key: "Tsk", label: { zh: "皮肤温度", en: "Skin temperature" }, shortLabel: "Tsk", domain: [15, 38], decimals: 1, palette: "thermal" },
  { key: "Tcr", label: { zh: "局部核心温度", en: "Local core temperature" }, shortLabel: "Tcr", domain: [34, 39], decimals: 2, palette: "thermal" },
  { key: "Wet", label: { zh: "皮肤湿润度", en: "Skin wettedness" }, shortLabel: "Wet", domain: [0, 1], decimals: 2, palette: "sequential" },
  { key: "BFsk", label: { zh: "皮肤血流", en: "Skin blood flow" }, shortLabel: "BFsk", domain: [0, 50], decimals: 1, palette: "sequential" },
  { key: "Mshiv", label: { zh: "战栗产热", en: "Shivering heat" }, shortLabel: "Mshiv", decimals: 2, palette: "sequential" },
  { key: "Esweat", label: { zh: "出汗蒸发", en: "Sweat evaporation" }, shortLabel: "Esweat", domain: [0, 30], decimals: 2, palette: "sequential" },
  { key: "THLsk", label: { zh: "局部皮肤散热", en: "Local skin heat loss" }, shortLabel: "THLsk", domain: [-10, 40], decimals: 1, palette: "diverging" },
  { key: "Icl", label: { zh: "局部衣着隔热", en: "Local clothing insulation" }, shortLabel: "Icl", domain: [0, 2], decimals: 2, palette: "sequential" },
];
