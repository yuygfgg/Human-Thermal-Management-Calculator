(function (globalScope) {
    "use strict";

    const ISO_9920_INTERCEPT_CLO = 0.161;
    const ISO_9920_GARMENT_SUM_FACTOR = 0.835;

    function nonNegativeNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function clothingModifier(item) {
        const modifier = Number(item && item.modifier);
        return Number.isFinite(modifier) && modifier > 0 ? modifier : 1.0;
    }

    function validateSegments(segments) {
        if (!Array.isArray(segments) || segments.length === 0) {
            throw new TypeError("segments must be a non-empty array");
        }

        const areaTotal = segments.reduce((total, segment) => {
            if (!segment || typeof segment.key !== "string" || !segment.key) {
                throw new TypeError("each segment must have a key");
            }
            const area = nonNegativeNumber(segment.area);
            if (area === 0) {
                throw new RangeError(`segment ${segment.key} must have a positive area`);
            }
            return total + area;
        }, 0);

        if (Math.abs(areaTotal - 1.0) > 1e-9) {
            throw new RangeError("segment areas must sum to 1.0");
        }
    }

    /**
     * Estimate basic clothing insulation with ISO 9920:2007, Equation 11.
     *
     * ISO 9920 gives one whole-body value and does not define regional
     * insulation. Regional values retain the input coverage distribution and
     * are scaled so their area-weighted mean equals the ISO ensemble value.
     */
    function calculateIso9920Insulation(items, segments) {
        validateSegments(segments);

        const outfit = Array.isArray(items) ? items : [];
        const summedRegionalClo = Object.fromEntries(
            segments.map(segment => [segment.key, 0]),
        );

        outfit.forEach(item => {
            const modifier = clothingModifier(item);
            const segmentValues = item && item.segClo && typeof item.segClo === "object"
                ? item.segClo
                : {};

            segments.forEach(segment => {
                summedRegionalClo[segment.key] += (
                    nonNegativeNumber(segmentValues[segment.key]) * modifier
                );
            });
        });

        const garmentInsulationSumClo = segments.reduce(
            (total, segment) => (
                total + summedRegionalClo[segment.key] * nonNegativeNumber(segment.area)
            ),
            0,
        );

        // The regression intercept is not a nude-body insulation value. Do not
        // extrapolate the garment-ensemble equation to an empty outfit.
        const ensembleInsulationClo = garmentInsulationSumClo > 0
            ? ISO_9920_INTERCEPT_CLO
                + ISO_9920_GARMENT_SUM_FACTOR * garmentInsulationSumClo
            : 0;
        const regionalScale = garmentInsulationSumClo > 0
            ? ensembleInsulationClo / garmentInsulationSumClo
            : 0;
        const regionalClo = Object.fromEntries(
            segments.map(segment => [
                segment.key,
                summedRegionalClo[segment.key] * regionalScale,
            ]),
        );

        return {
            garmentInsulationSumClo,
            ensembleInsulationClo,
            regionalClo,
        };
    }

    const api = Object.freeze({
        ISO_9920_INTERCEPT_CLO,
        ISO_9920_GARMENT_SUM_FACTOR,
        calculateIso9920Insulation,
    });

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        globalScope.ClothingInsulation = api;
    }
}(typeof globalThis !== "undefined" ? globalThis : self));
