import {
  BODY_SEGMENTS,
  CLOTHING_SEGMENTS,
  type BodySegment,
  type ClothingSegment,
  type GarmentInstance,
} from "./types";
import scenarioContract from "../../scenario-contract.json";

const insulationContract = scenarioContract.clothingInsulation;

export const ISO_9920_INTERCEPT_CLO = insulationContract.iso9920InterceptClo;
export const ISO_9920_GARMENT_SUM_FACTOR = insulationContract.iso9920GarmentSumFactor;

/**
 * Normalized body surface fractions used by the original calculator.
 * Bilateral JOS-3 regions are combined into one clothing region.
 */
export const CLOTHING_SEGMENT_AREA_FRACTIONS = Object.freeze(
  insulationContract.segmentAreaFractions,
) satisfies Readonly<Record<ClothingSegment, number>>;

export type RegionalClo = Record<ClothingSegment, number>;

export interface ClothingInsulation {
  garmentInsulationSumClo: number;
  ensembleInsulationClo: number;
  regionalClo: RegionalClo;
}

const BODY_TO_CLOTHING_SEGMENT = insulationContract.bodyToClothingSegment as Readonly<
  Record<BodySegment, ClothingSegment>
>;

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
