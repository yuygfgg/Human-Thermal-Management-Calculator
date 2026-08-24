import {
  BODY_SEGMENTS,
  CLOTHING_SEGMENTS,
  type BodySegment,
  type ClothingSegment,
  type GarmentInstance,
} from "./types";

export const ISO_9920_INTERCEPT_CLO = 0.161;
export const ISO_9920_GARMENT_SUM_FACTOR = 0.835;

/**
 * Normalized body surface fractions used by the original calculator.
 * Bilateral JOS-3 regions are combined into one clothing region.
 */
export const CLOTHING_SEGMENT_AREA_FRACTIONS: Readonly<Record<ClothingSegment, number>> = {
  Head: 0.055,
  Neck: 0.015,
  Chest: 0.12,
  Back: 0.12,
  Pelvis: 0.11,
  Shoulder: 0.04,
  Arm: 0.1,
  Hand: 0.05,
  Thigh: 0.18,
  Leg: 0.14,
  Foot: 0.07,
};

export type RegionalClo = Record<ClothingSegment, number>;

export interface ClothingInsulation {
  garmentInsulationSumClo: number;
  ensembleInsulationClo: number;
  regionalClo: RegionalClo;
}

const BODY_TO_CLOTHING_SEGMENT: Readonly<Record<BodySegment, ClothingSegment>> = {
  Head: "Head",
  Neck: "Neck",
  Chest: "Chest",
  Back: "Back",
  Pelvis: "Pelvis",
  LShoulder: "Shoulder",
  LArm: "Arm",
  LHand: "Hand",
  RShoulder: "Shoulder",
  RArm: "Arm",
  RHand: "Hand",
  LThigh: "Thigh",
  LLeg: "Leg",
  LFoot: "Foot",
  RThigh: "Thigh",
  RLeg: "Leg",
  RFoot: "Foot",
};

function emptyRegionalClo(): RegionalClo {
  return Object.fromEntries(CLOTHING_SEGMENTS.map((segment) => [segment, 0])) as RegionalClo;
}

/**
 * Calculate whole-body and regional clothing insulation.
 *
 * ISO 9920 Equation 11 supplies one ensemble value. The equation does not
 * define regional insulation. This function preserves the input coverage
 * pattern and scales all covered regions by one factor. The area-weighted
 * regional mean therefore equals the ISO 9920 ensemble value.
 */
export function calculateClothingInsulation(
  outfit: readonly GarmentInstance[],
): ClothingInsulation {
  const summedRegionalClo = emptyRegionalClo();

  for (const garment of outfit) {
    for (const segment of CLOTHING_SEGMENTS) {
      summedRegionalClo[segment] += (garment.segmentClo[segment] ?? 0) * garment.modifier;
    }
  }

  const garmentInsulationSumClo = CLOTHING_SEGMENTS.reduce(
    (sum, segment) => (
      sum + summedRegionalClo[segment] * CLOTHING_SEGMENT_AREA_FRACTIONS[segment]
    ),
    0,
  );

  if (garmentInsulationSumClo === 0) {
    return {
      garmentInsulationSumClo: 0,
      ensembleInsulationClo: 0,
      regionalClo: emptyRegionalClo(),
    };
  }

  const ensembleInsulationClo = ISO_9920_INTERCEPT_CLO
    + ISO_9920_GARMENT_SUM_FACTOR * garmentInsulationSumClo;
  const regionalScale = ensembleInsulationClo / garmentInsulationSumClo;
  const regionalClo = Object.fromEntries(
    CLOTHING_SEGMENTS.map((segment) => [segment, summedRegionalClo[segment] * regionalScale]),
  ) as RegionalClo;

  return { garmentInsulationSumClo, ensembleInsulationClo, regionalClo };
}

/** Convert clothing regions to the fixed JOS-3 17-node order. */
export function regionalCloToIcl17(
  regionalClo: Readonly<RegionalClo>,
): number[] {
  return BODY_SEGMENTS.map((segment) => regionalClo[BODY_TO_CLOTHING_SEGMENT[segment]]);
}

/** Calculate an outfit and return its insulation in JOS-3 17-node order. */
export function outfitToIcl17(outfit: readonly GarmentInstance[]): number[] {
  return regionalCloToIcl17(calculateClothingInsulation(outfit).regionalClo);
}
