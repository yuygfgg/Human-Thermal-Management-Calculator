"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ISO_9920_GARMENT_SUM_FACTOR,
    ISO_9920_INTERCEPT_CLO,
    calculateIso9920Insulation,
} = require("../clothing-insulation.js");

const segments = [
    { key: "Upper", area: 0.4 },
    { key: "Lower", area: 0.6 },
];

function weightedRegionalClo(regionalClo) {
    return segments.reduce(
        (total, segment) => total + regionalClo[segment.key] * segment.area,
        0,
    );
}

test("uses ISO 9920 Equation 11 for a clothing ensemble", () => {
    const result = calculateIso9920Insulation([
        { modifier: 1.0, segClo: { Upper: 0.5, Lower: 0.2 } },
        { modifier: 1.25, segClo: { Upper: 0.2, Lower: 0.4 } },
    ], segments);

    const expectedGarmentSum = 0.4 * (0.5 + 0.2 * 1.25)
        + 0.6 * (0.2 + 0.4 * 1.25);
    const expectedEnsemble = ISO_9920_INTERCEPT_CLO
        + ISO_9920_GARMENT_SUM_FACTOR * expectedGarmentSum;

    assert.ok(Math.abs(result.garmentInsulationSumClo - expectedGarmentSum) < 1e-12);
    assert.ok(Math.abs(result.ensembleInsulationClo - expectedEnsemble) < 1e-12);
    assert.ok(Math.abs(weightedRegionalClo(result.regionalClo) - expectedEnsemble) < 1e-12);
});

test("does not apply the removed geometric layer discount", () => {
    const result = calculateIso9920Insulation([
        { segClo: { Upper: 0.4 } },
        { segClo: { Upper: 0.2 } },
    ], segments);

    const expectedGarmentSum = 0.4 * (0.4 + 0.2);
    assert.ok(Math.abs(result.garmentInsulationSumClo - expectedGarmentSum) < 1e-12);
    assert.ok(Math.abs(
        result.ensembleInsulationClo
            - (ISO_9920_INTERCEPT_CLO + ISO_9920_GARMENT_SUM_FACTOR * expectedGarmentSum),
    ) < 1e-12);
});

test("keeps uncovered regions at zero", () => {
    const result = calculateIso9920Insulation([
        { segClo: { Upper: 0.5 } },
    ], segments);

    assert.equal(result.regionalClo.Lower, 0);
    assert.ok(result.regionalClo.Upper > 0);
});

test("returns zero insulation for an empty outfit", () => {
    const result = calculateIso9920Insulation([], segments);

    assert.equal(result.garmentInsulationSumClo, 0);
    assert.equal(result.ensembleInsulationClo, 0);
    assert.deepEqual(result.regionalClo, { Upper: 0, Lower: 0 });
});
