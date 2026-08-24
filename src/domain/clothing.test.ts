import { describe, expect, it } from "vitest";

import type { GarmentInstance } from "./types";
import {
  CLOTHING_SEGMENT_AREA_FRACTIONS,
  ISO_9920_GARMENT_SUM_FACTOR,
  ISO_9920_INTERCEPT_CLO,
  calculateClothingInsulation,
  outfitToIcl17,
  regionalCloToIcl17,
} from "./clothing";

function garment(overrides: Partial<GarmentInstance> = {}): GarmentInstance {
  return {
    id: "shirt",
    instanceId: "shirt-1",
    nameZh: "Shirt",
    nameEn: "Shirt",
    category: "base",
    modifier: 1,
    segmentClo: { Chest: 0.5, Back: 0.3, Arm: 0.2 },
    ...overrides,
  };
}

describe("calculateClothingInsulation", () => {
  it("applies ISO 9920 Equation 11 and preserves the regional coverage pattern", () => {
    const result = calculateClothingInsulation([
      garment(),
      garment({
        id: "coat",
        instanceId: "coat-1",
        modifier: 1.25,
        segmentClo: { Chest: 0.4, Back: 0.4, Pelvis: 0.3 },
      }),
    ]);

    const expectedSum = 0.12 * (0.5 + 0.4 * 1.25)
      + 0.12 * (0.3 + 0.4 * 1.25)
      + 0.1 * 0.2
      + 0.11 * (0.3 * 1.25);
    const expectedEnsemble = ISO_9920_INTERCEPT_CLO
      + ISO_9920_GARMENT_SUM_FACTOR * expectedSum;
    const weightedRegional = Object.entries(result.regionalClo).reduce(
      (sum, [segment, value]) => (
        sum + value * CLOTHING_SEGMENT_AREA_FRACTIONS[
          segment as keyof typeof CLOTHING_SEGMENT_AREA_FRACTIONS
        ]
      ),
      0,
    );

    expect(result.garmentInsulationSumClo).toBeCloseTo(expectedSum, 12);
    expect(result.ensembleInsulationClo).toBeCloseTo(expectedEnsemble, 12);
    expect(weightedRegional).toBeCloseTo(expectedEnsemble, 12);
    expect(result.regionalClo.Head).toBe(0);
  });

  it("returns an all-zero result for an empty outfit", () => {
    const result = calculateClothingInsulation([]);

    expect(result.garmentInsulationSumClo).toBe(0);
    expect(result.ensembleInsulationClo).toBe(0);
    expect(Object.values(result.regionalClo)).toEqual(Array(11).fill(0));
  });
});

describe("JOS-3 mapping", () => {
  it("duplicates bilateral clothing regions in the documented 17-node order", () => {
    const icl17 = regionalCloToIcl17({
      Head: 1,
      Neck: 2,
      Chest: 3,
      Back: 4,
      Pelvis: 5,
      Shoulder: 6,
      Arm: 7,
      Hand: 8,
      Thigh: 9,
      Leg: 10,
      Foot: 11,
    });

    expect(icl17).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 6, 7, 8, 9, 10, 11, 9, 10, 11]);
  });

  it("calculates exactly 17 finite values from an outfit", () => {
    const values = outfitToIcl17([garment()]);

    expect(values).toHaveLength(17);
    expect(values.every(Number.isFinite)).toBe(true);
  });
});
