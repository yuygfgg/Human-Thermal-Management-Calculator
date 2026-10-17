"""Thermal simulation adapter built around JOS-3.

Academic and standards references used by this module
------------------------------------------------------
[JOS3] Takahashi Y, Nomoto A, Yoda S, Hisayama R, Ogata M, Ozeki Y,
Tanabe S. Thermoregulation model JOS-3 with new open source code.
Energy and Buildings. 2021;231:110575.
https://doi.org/10.1016/j.enbuild.2020.110575

[XU2005] Xu X, Tikuisis P, Gonzalez R, Giesbrecht G. Thermoregulatory
model for prediction of long-term cold exposure. Computers in Biology and
Medicine. 2005;35(4):287-298.
https://doi.org/10.1016/j.compbiomed.2004.01.004

[TIKUISIS1999] Tikuisis P, Giesbrecht GG. Prediction of shivering heat
production from core and mean skin temperatures. European Journal of Applied
Physiology and Occupational Physiology. 1999;79(3):221-229.
https://doi.org/10.1007/s004210050499

[HONG1979] Hong SI, Nadel ER. Thermogenic control during exercise in a cold
environment. Journal of Applied Physiology. 1979;47(5):1084-1089.
https://doi.org/10.1152/jappl.1979.47.5.1084

[FUJIMOTO2019] Fujimoto T, Tsuji B, Sasaki Y, Dobashi K, Sengoku Y, Fujii N,
Nishiyasu T. Low-intensity exercise delays the shivering response to core
cooling. American Journal of Physiology-Regulatory, Integrative and
Comparative Physiology. 2019;316(5):R535-R542.
https://doi.org/10.1152/ajpregu.00203.2018

[HAMAN2017] Haman F, Blondin DP. Shivering thermogenesis in humans: Origin,
contribution and metabolic requirement. Temperature. 2017;4(3):217-226.
https://doi.org/10.1080/23328940.2017.1328999

[ISO7933] ISO 7933:2023. Ergonomics of the thermal environment - Analytical
determination and interpretation of thermal stress using calculation of the
predicted heat strain. https://www.iso.org/standard/75838.html

[ISO8996] ISO 8996:2021. Ergonomics of the thermal environment -
Determination of metabolic rate. https://www.iso.org/standard/74443.html

[DUBOIS1916] Du Bois D, Du Bois EF. A formula to estimate the approximate
surface area if height and weight be known. Archives of Internal Medicine.
1916;17:863-871.
https://doi.org/10.1001/archinte.1916.00080130010002

[DEURENBERG1991] Deurenberg P, Weststrate JA, Seidell JC. Body mass index as
a measure of body fatness: age- and sex-specific prediction formulas. British
Journal of Nutrition. 1991;65(2):105-114.
https://doi.org/10.1079/BJN19910073

[ISO9920] ISO 9920:2007. Ergonomics of the thermal environment - Estimation
of thermal insulation and water vapour resistance of a clothing ensemble.
https://www.iso.org/standard/39257.html

The JOS-3 source code attributes its skin-temperature shivering threshold
coefficients to "Asaka, 2016" but does not include a complete bibliographic
record. The coefficients are therefore cited here through [JOS3], which is
the reproducible source used by this adapter.

Implementation note: the references identify source models and observed
relationships. Numerical values that are not directly reported by a reference
remain project parameters. The dashboard comfort score, regional clothing
aggregation, and solar conversion are project-specific heuristics.
"""

from __future__ import annotations

import contextvars
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Sequence

import numpy as np

import jos3
from scenario_contract import (
    MAX_SCENARIO_DURATION_MIN,
    SCENARIO_CONTRACT,
    SCENARIO_SCHEMA_VERSION,
    assert_valid_scenario,
    outfit_to_icl17,
    validate_scenario,
)

_simulation_context: contextvars.ContextVar[Dict[str, Any]] = contextvars.ContextVar(
    "htm_simulation_context",
    default={
        "shivering_scale": 1.0,
        "shivering_gain_scale": 1.0,
        "shivering_core_shift_c": 0.0,
        "shivering_temperature_scale": 1.0,
        "shivering_fatigue_scale": 1.0,
        "shivering_max_w": 0.0,
        "shivering_smooth_threshold": False,
        "medium_hc_scale": 1.0,
    },
)

BODY_REGIONS = {
    "head": 0.07,
    "torso": 0.35,
    "arms": 0.14,
    "hands": 0.05,
    "legs": 0.32,
    "feet": 0.07,
}
IDEAL_CLO_RATIOS = {
    "head": 0.2,
    "torso": 1.0,
    "arms": 0.7,
    "hands": 0.15,
    "legs": 0.8,
    "feet": 0.25,
}

# The JOS-3 model [JOS3] calculates solar heat gain internally. These constants
# support the adapter's radiant-temperature history and medium-conductivity
# scaling.
HR_W_M2K = 4.7
SOLAR_EFFECTIVE_FACTOR = 0.12
AIR_THERMAL_CONDUCTIVITY_W_MK = 0.026
# These constants define the adapter's bounded exercise interpolation informed
# by [HONG1979] and [FUJIMOTO2019].
SHIVERING_MAX_THRESHOLD_SHIFT_C = 0.30
SHIVERING_GAIN_SUPPRESSION_START_MET = 1.0
SHIVERING_GAIN_SUPPRESSION_END_MET = 8.0
SHIVERING_MAX_GAIN_SUPPRESSION = 0.50

# These constants implement the low-core and maximum-response parts of the
# adapter, informed by [XU2005], [TIKUISIS1999], and [HAMAN2017].
SHIVERING_MAX_TO_BMR_RATIO = 4.0
# The 32/30 degC bounds and smooth shape follow the [XU2005] model form.
SHIVERING_LOW_CORE_ONSET_C = 32.0
SHIVERING_LOW_CORE_ARREST_C = 30.0
SHIVERING_LOW_CORE_EXPONENT = 1.4
SHIVERING_LOW_CORE_GAIN = 2.0
SHIVERING_ENDURANCE_ALPHA_H = 18.0
SHIVERING_ENDURANCE_EXPONENT = 4.0
SHIVERING_FATIGUE_SENSITIVITY = 0.38
# [ISO7933] expresses evaporation as heat flow divided by latent heat. 2.42
# kJ/g is a representative value near skin temperature; the result estimates
# evaporated water and not total gland secretion.
SWEAT_LATENT_HEAT_J_PER_G = 2420.0

JOS3_REGION_SUFFIXES = (
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
)


@dataclass(frozen=True)
class NumericProfile:
    start: float
    end: float

    def sample(self, step: int, duration_min: int) -> float:
        if duration_min <= 1:
            return self.start if duration_min == 0 else self.end
        fraction = step / (duration_min - 1)
        return self.start + ((self.end - self.start) * fraction)

    def to_json(self) -> Dict[str, float]:
        return {"start": self.start, "end": self.end}


@dataclass(frozen=True)
class SubjectConfig:
    sex: str
    height_cm: float
    weight_kg: float
    age_years: int
    base_core_temp_c: float


@dataclass(frozen=True)
class GarmentConfig:
    id: str
    instance_id: str
    name_zh: str
    name_en: str
    category: str
    modifier: float
    segment_clo: tuple[tuple[str, float], ...]


@dataclass(frozen=True)
class StageConfig:
    id: str
    name: str
    duration_min: int
    air_temp_c: NumericProfile
    wind_speed_ms: NumericProfile
    rh_percent: NumericProfile
    solar_radiation_wm2: NumericProfile
    medium_thermal_conductivity_w_mk: NumericProfile
    activity_met: NumericProfile
    posture: str
    outfit: tuple[GarmentConfig, ...]
    icl17: tuple[float, ...]


@dataclass(frozen=True)
class ScenarioConfig:
    name: str
    subject: SubjectConfig
    stages: tuple[StageConfig, ...]


@dataclass(frozen=True)
class StageSample:
    air_temp_c: float
    wind_speed_ms: float
    rh_percent: float
    solar_radiation_wm2: float
    medium_thermal_conductivity_w_mk: float
    activity_met: float
    posture: str
    icl17: tuple[float, ...]

    @property
    def delta_tr_c(self) -> float:
        return (self.solar_radiation_wm2 * SOLAR_EFFECTIVE_FACTOR) / HR_W_M2K

    @property
    def radiant_temp_c(self) -> float:
        return self.air_temp_c + self.delta_tr_c

    @property
    def medium_hc_scale(self) -> float:
        return self.medium_thermal_conductivity_w_mk / AIR_THERMAL_CONDUCTIVITY_W_MK


@dataclass(frozen=True)
class ActivityState:
    work_w: float
    suppression: float
    scale: float
    threshold_shift_c: float


@dataclass
class ShiveringFatigueState:
    """Track cumulative shivering load using the [XU2005] model form.

    The state applies the endurance-time relation to the simulated shivering
    history.
    """

    max_shivering_w: float
    exposure_load: float = 0.0
    consumed_energy_j: float = 0.0
    scale: float = 1.0

    def update(self, shivering_w: float, dtime_s: float) -> None:
        shivering_w = max(0.0, float(shivering_w))
        self.consumed_energy_j += shivering_w * dtime_s
        relative_load = _clamp(
            shivering_w / max(self.max_shivering_w, 1e-6), 0.0, 0.999
        )
        if relative_load <= 1e-6:
            return

        endurance_h = (SHIVERING_ENDURANCE_ALPHA_H / relative_load) * math.exp(
            -SHIVERING_ENDURANCE_EXPONENT * relative_load
        )
        self.exposure_load += (dtime_s / 3600.0) / endurance_h
        if self.exposure_load <= 1.0:
            self.scale = 1.0
        else:
            self.scale = _sech(
                SHIVERING_FATIGUE_SENSITIVITY * (self.exposure_load - 1.0)
            )


def _patch_jos3_shivering() -> None:
    try:
        import jos3.thermoregulation as threg
    except Exception:
        return
    if getattr(threg, "_htm_shivering_patched", False):
        return

    original = threg.shivering

    def smooth_threshold_inputs(
        forwarded_args: list[Any],
        forwarded_kwargs: Dict[str, Any],
        core_shift_c: float,
    ) -> None:
        """Replace JOS-3's binary threshold with a continuous core drive.

        JOS-3 computes the shivering drive from ``-err_cr[0]`` and then
        applies a binary skin-temperature threshold. The binary comparison
        creates chatter when core temperature is close to that threshold. Keep the
        skin-temperature-dependent threshold, but express the
        drive as ``threshold - core temperature`` so it reaches zero smoothly.
        The base threshold and the JOS-3 implementation are cited as [JOS3].
        """
        if len(forwarded_args) >= 4:
            err_cr = np.asarray(forwarded_args[0], dtype=float).copy()
            tcr = np.asarray(forwarded_args[2], dtype=float)
            tsk = np.asarray(forwarded_args[3], dtype=float)
            sex = (
                forwarded_args[8]
                if len(forwarded_args) >= 9
                else forwarded_kwargs.get("sex", "male")
            )
            options_index = 10
            if len(forwarded_args) > options_index:
                options = dict(forwarded_args[options_index] or {})
                forwarded_args[options_index] = options
            else:
                options = dict(forwarded_kwargs.get("options") or {})
                forwarded_kwargs["options"] = options
        else:
            err_cr = np.asarray(forwarded_kwargs["err_cr"], dtype=float).copy()
            tcr = np.asarray(forwarded_kwargs["tcr"], dtype=float)
            tsk = np.asarray(forwarded_kwargs["tsk"], dtype=float)
            sex = forwarded_kwargs.get("sex", "male")
            options = dict(forwarded_kwargs.get("options") or {})
            forwarded_kwargs["options"] = options

        # This is the skin-temperature threshold implemented by JOS-3 [JOS3].
        # Reuse the JOS-3 package equation while removing only the discontinuous
        # comparison.
        skin_weights = np.asarray(getattr(threg, "_BSAst"), dtype=float)
        mean_skin_c = float(np.average(tsk, weights=skin_weights))
        if mean_skin_c < 31.0:
            threshold_c = 36.6
        elif str(sex).lower() == "male":
            threshold_c = -0.2436 * mean_skin_c + 44.10
        else:
            threshold_c = -0.2250 * mean_skin_c + 43.05

        effective_threshold_c = threshold_c - core_shift_c
        err_cr[0] = float(tcr[0]) - effective_threshold_c
        if len(forwarded_args) >= 1:
            forwarded_args[0] = err_cr
        else:
            forwarded_kwargs["err_cr"] = err_cr

        # Prevent the original function from applying its binary gate to the
        # already continuous error signal.
        options["shivering_threshold"] = False

    def shivering_with_activity(*args: Any, **kwargs: Any) -> Any:
        context = _simulation_context.get()
        forwarded_args = list(args)
        forwarded_kwargs = dict(kwargs)
        core_shift_c = float(context.get("shivering_core_shift_c", 0.0))

        if context.get("shivering_smooth_threshold", False):
            smooth_threshold_inputs(forwarded_args, forwarded_kwargs, core_shift_c)

        value = np.asarray(original(*forwarded_args, **forwarded_kwargs), dtype=float)
        max_shivering_w = float(context.get("shivering_max_w", 0.0))
        total_shivering_w = float(value.sum())
        if max_shivering_w > 0.0 and total_shivering_w > max_shivering_w:
            value *= max_shivering_w / total_shivering_w
        gain_scale = float(
            context.get("shivering_gain_scale", context.get("shivering_scale", 1.0))
        )
        temperature_scale = float(context.get("shivering_temperature_scale", 1.0))
        fatigue_scale = float(context.get("shivering_fatigue_scale", 1.0))
        scale = gain_scale * temperature_scale * fatigue_scale
        return value * scale

    threg.shivering = shivering_with_activity
    threg._htm_shivering_patched = True


def _patch_jos3_fixed_hc() -> None:
    """Apply the medium conductivity scale after JOS-3 normalizes ``hc``."""
    try:
        import jos3.thermoregulation as threg
    except Exception:
        return
    if getattr(threg, "_htm_fixed_hc_patched", False):
        return

    original = threg.fixed_hc

    def fixed_hc_with_medium(*args: Any, **kwargs: Any) -> Any:
        value = original(*args, **kwargs)
        scale = _simulation_context.get().get("medium_hc_scale", 1.0)
        return np.asarray(value, dtype=float) * float(scale)

    threg.fixed_hc = fixed_hc_with_medium
    threg._htm_fixed_hc_patched = True


_patch_jos3_shivering()
_patch_jos3_fixed_hc()


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _sech(x: float) -> float:
    return 1.0 / math.cosh(_clamp(float(x), 0.0, 700.0))


def _json_sanitize(obj: Any) -> Any:
    if isinstance(obj, (np.floating, np.integer)):
        return float(obj) if isinstance(obj, np.floating) else int(obj)
    if isinstance(obj, np.ndarray):
        return [_json_sanitize(x) for x in obj.tolist()]
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if isinstance(obj, dict):
        return {k: _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_sanitize(v) for v in obj]
    return obj


def _stddev(vals: List[float]) -> float:
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    variance = sum((v - mean) ** 2 for v in vals) / len(vals)
    return math.sqrt(variance)


def _calculate_instant_comfort_score(
    *,
    core_t: float,
    base_core_t: float,
    skin_t: float,
    shiver_intensity: float,
    sweat_intensity: float,
    net_rate: float,
    regional_clo: Dict[str, float],
) -> float:
    """Return the dashboard comfort score."""
    temp_diff = core_t - base_core_t
    skin_dev = 0.0
    if skin_t < 32.0:
        skin_dev = 32.0 - skin_t
    elif skin_t > 34.0:
        skin_dev = skin_t - 34.0

    p_core = abs(temp_diff) * 35.0
    p_skin = skin_dev * (8.0 if skin_t < 32.0 else 6.0 if skin_t > 34.0 else 0.0)
    p_response = (shiver_intensity + sweat_intensity) * 0.35
    p_net = abs(net_rate) * 0.15
    primary = p_core + p_skin + p_response

    normalized = [
        float(regional_clo.get(region, 0.0) or 0.0)
        / float(IDEAL_CLO_RATIOS.get(region, 1.0) or 1.0)
        for region in BODY_REGIONS
    ]
    imbalance = _stddev(normalized) * 50.0 * max(0.0, 1.0 - primary / 40.0)
    return _clamp(100.0 - p_core - p_skin - p_response - p_net - imbalance, 0.0, 100.0)


def _bsa_m2(height_cm: float, weight_kg: float) -> float:
    """Calculate body surface area with the Du Bois formula [DUBOIS1916]."""
    return 0.007184 * (height_cm**0.725) * (weight_kg**0.425)


def _body_fat_percent(
    gender: str, height_cm: float, weight_kg: float, age_years: int
) -> float:
    """Estimate body fat with the age/sex BMI formula from [DEURENBERG1991]."""
    bmi = weight_kg / ((height_cm / 100.0) ** 2)
    if gender == "female":
        fat = (1.20 * bmi) + (0.23 * age_years) - 5.4
    else:
        fat = (1.20 * bmi) + (0.23 * age_years) - 16.2
    return _clamp(float(fat), 3.0, 60.0)


def _profile(value: Mapping[str, Any]) -> NumericProfile:
    return NumericProfile(start=float(value["start"]), end=float(value["end"]))


def _normalize_outfit(
    value: Sequence[Mapping[str, Any]],
) -> tuple[GarmentConfig, ...]:
    return tuple(
        GarmentConfig(
            id=str(garment["id"]),
            instance_id=str(garment["instanceId"]),
            name_zh=str(garment["nameZh"]),
            name_en=str(garment["nameEn"]),
            category=str(garment["category"]),
            modifier=float(garment["modifier"]),
            segment_clo=tuple(
                (str(segment), float(clo))
                for segment, clo in garment["segmentClo"].items()
            ),
        )
        for garment in value
    )


def _normalize_scenario(scenario: Mapping[str, Any]) -> ScenarioConfig:
    assert_valid_scenario(scenario)
    subject_value = scenario["subject"]
    subject = SubjectConfig(
        sex=str(subject_value["sex"]),
        height_cm=float(subject_value["heightCm"]),
        weight_kg=float(subject_value["weightKg"]),
        age_years=int(subject_value["ageYears"]),
        base_core_temp_c=float(subject_value["referenceCoreTempC"]),
    )

    stages: List[StageConfig] = []
    for stage_value in scenario["stages"]:
        environment = stage_value["environment"]
        raw_outfit = stage_value["outfit"]
        outfit = _normalize_outfit(raw_outfit)
        stages.append(
            StageConfig(
                id=str(stage_value["id"]),
                name=str(stage_value["name"]),
                duration_min=int(stage_value["durationMin"]),
                air_temp_c=_profile(environment["airTempC"]),
                wind_speed_ms=_profile(environment["windSpeedMs"]),
                rh_percent=_profile(environment["relativeHumidityPercent"]),
                solar_radiation_wm2=_profile(environment["solarRadiationWm2"]),
                medium_thermal_conductivity_w_mk=_profile(
                    environment["mediumThermalConductivityWmK"]
                ),
                activity_met=_profile(stage_value["activityMet"]),
                posture=str(stage_value["posture"]),
                outfit=outfit,
                icl17=outfit_to_icl17(raw_outfit),
            )
        )

    return ScenarioConfig(
        name=str(scenario["name"]),
        subject=subject,
        stages=tuple(stages),
    )


def _icl17_to_regional_clo(icl17: np.ndarray) -> Dict[str, float]:
    """Aggregate JOS-3 nodes using the clothing ensemble mapping [ISO9920].

    ISO 9920 supports the insulation estimate; the six-region aggregation is
    defined by the dashboard.
    """
    area = {
        "head": (0.055, 0.015),
        "torso": (0.12, 0.12, 0.11),
        "arms": (0.04, 0.10),
        "legs": (0.18, 0.14),
    }
    head, neck = float(icl17[0]), float(icl17[1])
    chest, back, pelvis = (float(icl17[index]) for index in (2, 3, 4))
    shoulder = 0.5 * (float(icl17[5]) + float(icl17[8]))
    arm = 0.5 * (float(icl17[6]) + float(icl17[9]))
    hand = 0.5 * (float(icl17[7]) + float(icl17[10]))
    thigh = 0.5 * (float(icl17[11]) + float(icl17[14]))
    leg = 0.5 * (float(icl17[12]) + float(icl17[15]))
    foot = 0.5 * (float(icl17[13]) + float(icl17[16]))

    def weighted(values: tuple[float, ...], weights: tuple[float, ...]) -> float:
        return float(
            sum(value * weight for value, weight in zip(values, weights)) / sum(weights)
        )

    return {
        "head": weighted((head, neck), area["head"]),
        "torso": weighted((chest, back, pelvis), area["torso"]),
        "arms": weighted((shoulder, arm), area["arms"]),
        "hands": hand,
        "legs": weighted((thigh, leg), area["legs"]),
        "feet": foot,
    }


def _sum_segments(data: Dict[str, List[float]], prefix: str) -> List[float]:
    keys = sorted(key for key in data if key.startswith(prefix))
    if not keys:
        return [0.0 for _ in range(len(data.get("ModTime", [])))]
    total = np.zeros(len(data[keys[0]]), dtype=float)
    for key in keys:
        total += np.asarray(data[key], dtype=float)
    return total.tolist()


def _sanitize_jos3_results(data: Dict[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = {}
    for key, series in data.items():
        if not isinstance(series, (list, tuple, np.ndarray)):
            continue
        values = []
        for value in series:
            if hasattr(value, "total_seconds"):
                values.append(float(value.total_seconds()))
            else:
                values.append(_json_sanitize(value))
        output[str(key)] = values
    return output


def _latest_tcb(model: Any, fallback: float) -> float:
    value = np.asarray(getattr(model, "Tcb", []), dtype=float).reshape(-1)
    return float(value[-1]) if value.size else fallback


def _latest_shivering_w(model: Any) -> float:
    """Read only the last model row instead of rebuilding the whole history."""
    history = getattr(model, "_history", None)
    if not history:
        return 0.0
    value = history[-1].get("Mshiv", 0.0)
    return float(np.asarray(value, dtype=float).sum())


def _low_core_shivering_scale(core_temp_c: float) -> float:
    """Apply the low-core inhibition described by [XU2005]."""
    if core_temp_c >= SHIVERING_LOW_CORE_ONSET_C:
        return 1.0
    if core_temp_c <= SHIVERING_LOW_CORE_ARREST_C:
        return 0.0
    argument = SHIVERING_LOW_CORE_GAIN * (
        (SHIVERING_LOW_CORE_ONSET_C - core_temp_c) ** SHIVERING_LOW_CORE_EXPONENT
    )
    return _sech(argument)


def _activity_state(
    activity_met: float,
    bsa_m2: float,
) -> ActivityState:
    # ISO 8996 [ISO8996] defines the met convention used by the scenario.
    # Hong and Nadel [HONG1979] and Fujimoto et al. [FUJIMOTO2019] support the
    # exercise-suppression direction used by the bounded interpolation below.
    work_w = max(0.0, (activity_met - 1.0) * 58.2 * bsa_m2)
    low_intensity_fraction = _clamp(activity_met - 1.0, 0.0, 1.0)
    threshold_shift_c = SHIVERING_MAX_THRESHOLD_SHIFT_C * low_intensity_fraction
    gain_range = (
        SHIVERING_GAIN_SUPPRESSION_END_MET - SHIVERING_GAIN_SUPPRESSION_START_MET
    )
    gain_suppression = SHIVERING_MAX_GAIN_SUPPRESSION * _clamp(
        (activity_met - SHIVERING_GAIN_SUPPRESSION_START_MET) / gain_range,
        0.0,
        1.0,
    )
    return ActivityState(
        work_w=work_w,
        suppression=gain_suppression,
        scale=1.0 - gain_suppression,
        threshold_shift_c=threshold_shift_c,
    )


def _sample_stage(stage: StageConfig, step: int | None = None) -> StageSample:
    def sample(profile: NumericProfile) -> float:
        if step is None:
            return profile.start
        return profile.sample(step, stage.duration_min)

    return StageSample(
        air_temp_c=sample(stage.air_temp_c),
        wind_speed_ms=sample(stage.wind_speed_ms),
        rh_percent=sample(stage.rh_percent),
        solar_radiation_wm2=sample(stage.solar_radiation_wm2),
        medium_thermal_conductivity_w_mk=sample(stage.medium_thermal_conductivity_w_mk),
        activity_met=sample(stage.activity_met),
        posture=stage.posture,
        icl17=stage.icl17,
    )


def _apply_conditions(
    model: Any,
    conditions: StageSample,
    *,
    bsa_m2: float,
) -> ActivityState:
    model.Ta = conditions.air_temp_c
    model.Tr = conditions.radiant_temp_c
    model.RH = conditions.rh_percent
    model.Va = conditions.wind_speed_ms
    model.posture = conditions.posture
    model.Icl = np.asarray(conditions.icl17, dtype=float)

    # 58.2 W/m² is the 1-met convention used by [ISO8996]. JOS-3's PAR is
    # the activity-to-basal metabolic ratio, so the scenario's met input is
    # converted to that ratio before each model step.
    model.PAR = float(
        _clamp((conditions.activity_met * 58.2) / float(model.BMR), 0.8, 12.0)
    )
    activity = _activity_state(
        conditions.activity_met,
        bsa_m2,
    )
    model.options["shivering_activity_scale"] = activity.scale
    model.options["shivering_activity_suppression_coeff"] = activity.suppression
    model.options["shivering_activity_work_w"] = activity.work_w
    model.options["shivering_threshold_shift_c"] = activity.threshold_shift_c
    return activity


def _append_condition_sample(
    history: Dict[str, List[Any]],
    stage: StageConfig,
    conditions: StageSample,
    activity: ActivityState,
    *,
    temperature_scale: float,
    fatigue_scale: float,
    fatigue_load: float,
) -> None:
    effective_scale = activity.scale * temperature_scale * fatigue_scale
    row = {
        "stageId": stage.id,
        "stageName": stage.name,
        "airTemp": conditions.air_temp_c,
        "radiantTemp": conditions.radiant_temp_c,
        "relativeHumidity": conditions.rh_percent,
        "airSpeed": conditions.wind_speed_ms,
        "solarRadiation": conditions.solar_radiation_wm2,
        "mediumThermalConductivity": conditions.medium_thermal_conductivity_w_mk,
        "mediumHcScale": conditions.medium_hc_scale,
        "activityMet": conditions.activity_met,
        "posture": conditions.posture,
        "icl17": list(conditions.icl17),
        "shiveringActivityScale": activity.scale,
        "shiveringSuppressionCoeff": activity.suppression,
        "shiveringWorkWatts": activity.work_w,
        "shiveringThresholdShiftC": activity.threshold_shift_c,
        "shiveringTemperatureScale": temperature_scale,
        "shiveringFatigueScale": fatigue_scale,
        "shiveringFatigueLoad": fatigue_load,
        "effectiveShiveringScale": effective_scale,
    }
    if not history:
        history.update({key: [value] for key, value in row.items()})
        return
    for key, value in row.items():
        history[key].append(value)


def _regional_matrix(
    raw_results: Mapping[str, List[Any]], prefix: str
) -> List[List[Any]]:
    columns = [
        raw_results.get(f"{prefix}{suffix}", []) for suffix in JOS3_REGION_SUFFIXES
    ]
    row_count = len(raw_results.get("ModTime", []))
    if any(len(column) != row_count for column in columns):
        raise RuntimeError(f"JOS-3 returned an incomplete {prefix} regional series")
    return [[columns[column][row] for column in range(17)] for row in range(row_count)]


def _average(values: Sequence[float]) -> float:
    return float(sum(values) / len(values)) if values else 0.0


def _evaporated_sweat_rate_g_per_h(evaporative_heat_w: Sequence[float]) -> List[float]:
    """Convert JOS-3 evaporative heat loss using [ISO7933].

    The conversion divides evaporative heat flow by a representative latent
    heat of vaporization. It estimates water that evaporates at the skin; it
    does not estimate total gland secretion or dripping sweat.
    """
    return [
        max(0.0, float(value)) * 3600.0 / SWEAT_LATENT_HEAT_J_PER_G
        for value in evaporative_heat_w
    ]


def _cumulative_evaporated_sweat_ml(
    evaporative_heat_w: Sequence[float],
    time_min: Sequence[float],
) -> List[float]:
    """Integrate the [ISO7933] evaporated-water estimate by trapezoids."""
    if not evaporative_heat_w:
        return []
    cumulative = [0.0]
    for index in range(1, len(evaporative_heat_w)):
        dt_s = max(0.0, float(time_min[index] - time_min[index - 1]) * 60.0)
        mean_heat_w = max(
            0.0,
            (float(evaporative_heat_w[index - 1]) + float(evaporative_heat_w[index]))
            / 2.0,
        )
        cumulative.append(
            cumulative[-1] + mean_heat_w * dt_s / SWEAT_LATENT_HEAT_J_PER_G
        )
    return cumulative


def _canonical_scenario(config: ScenarioConfig) -> Dict[str, Any]:
    return {
        "schemaVersion": SCENARIO_SCHEMA_VERSION,
        "name": config.name,
        "subject": {
            "sex": config.subject.sex,
            "heightCm": config.subject.height_cm,
            "weightKg": config.subject.weight_kg,
            "ageYears": config.subject.age_years,
            "referenceCoreTempC": config.subject.base_core_temp_c,
        },
        "stages": [
            {
                "id": stage.id,
                "name": stage.name,
                "durationMin": stage.duration_min,
                "environment": {
                    "airTempC": stage.air_temp_c.to_json(),
                    "windSpeedMs": stage.wind_speed_ms.to_json(),
                    "relativeHumidityPercent": stage.rh_percent.to_json(),
                    "solarRadiationWm2": stage.solar_radiation_wm2.to_json(),
                    "mediumThermalConductivityWmK": (
                        stage.medium_thermal_conductivity_w_mk.to_json()
                    ),
                },
                "activityMet": stage.activity_met.to_json(),
                "posture": stage.posture,
                "outfit": [
                    {
                        "id": garment.id,
                        "instanceId": garment.instance_id,
                        "nameZh": garment.name_zh,
                        "nameEn": garment.name_en,
                        "category": garment.category,
                        "modifier": garment.modifier,
                        "segmentClo": dict(garment.segment_clo),
                    }
                    for garment in stage.outfit
                ],
            }
            for stage in config.stages
        ],
    }


def simulate_scenario(scenario: Mapping[str, Any]) -> Dict[str, Any]:
    config = _normalize_scenario(scenario)
    subject = config.subject
    bsa = _bsa_m2(subject.height_cm, subject.weight_kg)
    fat_pct = _body_fat_percent(
        subject.sex,
        subject.height_cm,
        subject.weight_kg,
        subject.age_years,
    )

    first_stage = config.stages[0]
    initial_conditions = _sample_stage(first_stage)
    _simulation_context.set(
        {
            "shivering_scale": 1.0,
            "shivering_gain_scale": 1.0,
            "shivering_core_shift_c": 0.0,
            "shivering_temperature_scale": 1.0,
            "shivering_fatigue_scale": 1.0,
            "shivering_max_w": 0.0,
            "shivering_smooth_threshold": False,
            "medium_hc_scale": initial_conditions.medium_hc_scale,
        }
    )
    model = jos3.JOS3(
        height=subject.height_cm / 100.0,
        weight=subject.weight_kg,
        fat=fat_pct,
        age=subject.age_years,
        sex=subject.sex,
        ex_output=["Tcb", "BFsk", "Mshiv", "Esweat"],
    )
    # Use the JOS-3 skin-temperature-dependent threshold [JOS3]. The wrapper
    # applies it as a continuous drive to avoid binary threshold chatter.
    model.options["shivering_threshold"] = False
    initial_activity = _apply_conditions(
        model,
        initial_conditions,
        bsa_m2=bsa,
    )
    initial_temperature_scale = _low_core_shivering_scale(
        _latest_tcb(model, subject.base_core_temp_c)
    )
    resting_metabolic_w = max(1.0, float(model.BMR) * bsa)
    fatigue_state = ShiveringFatigueState(
        max_shivering_w=SHIVERING_MAX_TO_BMR_RATIO * resting_metabolic_w
    )
    _simulation_context.set(
        {
            "shivering_scale": initial_activity.scale,
            "shivering_gain_scale": initial_activity.scale,
            "shivering_core_shift_c": initial_activity.threshold_shift_c,
            "shivering_temperature_scale": initial_temperature_scale,
            "shivering_fatigue_scale": fatigue_state.scale,
            "shivering_max_w": fatigue_state.max_shivering_w,
            "shivering_smooth_threshold": True,
            "medium_hc_scale": initial_conditions.medium_hc_scale,
        }
    )

    condition_history: Dict[str, List[Any]] = {}
    _append_condition_sample(
        condition_history,
        first_stage,
        initial_conditions,
        initial_activity,
        temperature_scale=initial_temperature_scale,
        fatigue_scale=fatigue_state.scale,
        fatigue_load=fatigue_state.exposure_load,
    )

    stage_ranges: List[Dict[str, Any]] = []
    elapsed_min = 0
    for stage_index, stage in enumerate(config.stages):
        start_min = elapsed_min
        for step in range(stage.duration_min):
            conditions = _sample_stage(stage, step)
            activity = _apply_conditions(
                model,
                conditions,
                bsa_m2=bsa,
            )
            fatigue_scale = fatigue_state.scale
            temperature_scale = _low_core_shivering_scale(
                _latest_tcb(model, subject.base_core_temp_c)
            )
            _simulation_context.set(
                {
                    "shivering_scale": activity.scale,
                    "shivering_gain_scale": activity.scale,
                    "shivering_core_shift_c": activity.threshold_shift_c,
                    "shivering_temperature_scale": temperature_scale,
                    "shivering_fatigue_scale": fatigue_scale,
                    "shivering_max_w": fatigue_state.max_shivering_w,
                    "shivering_smooth_threshold": True,
                    "medium_hc_scale": conditions.medium_hc_scale,
                }
            )
            model.simulate(times=1, dtime=60)
            fatigue_state.update(_latest_shivering_w(model), 60.0)
            _append_condition_sample(
                condition_history,
                stage,
                conditions,
                activity,
                temperature_scale=temperature_scale,
                fatigue_scale=fatigue_scale,
                fatigue_load=fatigue_state.exposure_load,
            )

        elapsed_min += stage.duration_min
        has_results = stage.duration_min > 0
        stage_ranges.append(
            {
                "id": stage.id,
                "name": stage.name,
                "stageIndex": stage_index,
                "startMinute": start_min,
                "endMinute": elapsed_min,
                "durationMin": stage.duration_min,
                "resultStartIndex": start_min + 1 if has_results else None,
                "resultEndIndex": elapsed_min if has_results else None,
                "initialStateIndex": 0 if stage_index == 0 else None,
            }
        )

    raw_results = _sanitize_jos3_results(model.dict_results())
    time_sec = raw_results.get("ModTime", [])
    time_min = (np.asarray(time_sec, dtype=float) / 60.0).tolist() if time_sec else []
    core_temp = [float(x) for x in raw_results.get("Tcb", [])]
    skin_temp = [float(x) for x in raw_results.get("TskMean", [])]
    met_w = [float(x) for x in raw_results.get("Met", [])]
    res_w = [float(x) for x in raw_results.get("RES", [])]
    dry_loss_w = _sum_segments(raw_results, "SHLsk")
    skin_latent_loss_w = _sum_segments(raw_results, "LHLsk")
    sweat_loss_w = _sum_segments(raw_results, "Esweat")
    thl_sk_w = _sum_segments(raw_results, "THLsk")
    bf_sk = _sum_segments(raw_results, "BFsk")
    mshiv_w = _sum_segments(raw_results, "Mshiv")
    shivering_heat_w = [max(0.0, float(value)) for value in mshiv_w]
    shivering_capacity_percent = (
        (
            100.0
            * np.asarray(shivering_heat_w, dtype=float)
            / max(fatigue_state.max_shivering_w, 1e-6)
        )
        .clip(0.0, 100.0)
        .tolist()
    )
    shivering_rmr_multiple = (
        # Displayed as a met-like incremental contribution by project
        # convention. The stored ratio remains Mshiv/RMR for compatibility.
        np.asarray(shivering_heat_w, dtype=float)
        / max(resting_metabolic_w, 1e-6)
    ).tolist()
    sweat_evaporation_rate_g_per_h = _evaporated_sweat_rate_g_per_h(sweat_loss_w)
    cumulative_sweat_evaporated_ml = _cumulative_evaporated_sweat_ml(
        sweat_loss_w,
        time_min,
    )

    expected_rows = len(time_min)
    if any(len(values) != expected_rows for values in condition_history.values()):
        raise RuntimeError("condition history is not aligned with JOS-3 results")

    solar_gain_w = [
        float(value) * bsa * SOLAR_EFFECTIVE_FACTOR
        for value in condition_history["solarRadiation"]
    ]
    met_arr = np.asarray(met_w, dtype=float)
    res_arr = np.asarray(res_w, dtype=float)
    dry_arr = np.asarray(dry_loss_w, dtype=float)
    latent_arr = np.asarray(skin_latent_loss_w, dtype=float)
    net_rate_w = (met_arr - res_arr - dry_arr - latent_arr).tolist()
    total_gain_w = met_arr.tolist()
    total_loss_w = (res_arr + dry_arr + latent_arr).tolist()
    # JOS-3 reports Met as total metabolic heat and Mshiv as the shivering
    # component [JOS3]. This ratio is a heat-allocation diagnostic. The UI uses
    # the separate model-capacity percentage only as the source of its bar.
    shiver_intensity = (
        (100.0 * (np.asarray(mshiv_w) / np.maximum(1e-6, met_arr)))
        .clip(0, 100)
        .tolist()
    )
    # WetMean is JOS-3's whole-body skin wettedness fraction [JOS3].
    wet_mean = [float(x) for x in raw_results.get("WetMean", [])]
    skin_wettedness_percent = (
        (100.0 * np.asarray(wet_mean, dtype=float)).clip(0.0, 100.0).tolist()
    )
    # Preserve the legacy comfort index. Physical output uses WetMean and
    # evaporative heat flow directly.
    eff_sweat = np.maximum(0.0, (np.asarray(wet_mean) - 0.06) / 0.94).clip(0, 1)
    sweat_intensity = (100.0 * eff_sweat).tolist()

    baseline_bf = float(bf_sk[0]) if bf_sk else 0.0
    if baseline_bf <= 1e-6:
        vaso_i = [0.0 for _ in time_min]
        dilate_i = [0.0 for _ in time_min]
    else:
        bf = np.asarray(bf_sk, dtype=float)
        vaso_i = (
            (100.0 * np.maximum(0.0, (baseline_bf - bf) / baseline_bf))
            .clip(0, 100)
            .tolist()
        )
        dilate_i = (
            (100.0 * np.maximum(0.0, (bf - baseline_bf) / baseline_bf))
            .clip(0, 100)
            .tolist()
        )

    comfort_sum = 0.0
    instant_comfort_series: List[float] = []
    comfort_series: List[float] = []
    for idx in range(len(time_min)):
        regional_clo = _icl17_to_regional_clo(
            np.asarray(condition_history["icl17"][idx], dtype=float)
        )
        instant = _calculate_instant_comfort_score(
            core_t=float(core_temp[idx]),
            base_core_t=subject.base_core_temp_c,
            skin_t=float(skin_temp[idx]),
            shiver_intensity=float(shiver_intensity[idx]),
            sweat_intensity=float(sweat_intensity[idx]),
            net_rate=float(net_rate_w[idx]),
            regional_clo=regional_clo,
        )
        comfort_sum += instant
        instant_comfort_series.append(instant)
        comfort_series.append(comfort_sum / float(idx + 1))

    final_state = {
        "heatProductionWatts": float(met_w[-1]) if met_w else 0.0,
        "solarHeatGainWatts": float(solar_gain_w[-1]) if solar_gain_w else 0.0,
        "heatLossResp": float(res_w[-1]) if res_w else 0.0,
        "heatLossDry": float(dry_loss_w[-1]) if dry_loss_w else 0.0,
        "sweatingHeatLoss": float(sweat_loss_w[-1]) if sweat_loss_w else 0.0,
        "skinLatentHeatLoss": (
            float(skin_latent_loss_w[-1]) if skin_latent_loss_w else 0.0
        ),
        "netHeatRateWatts": float(net_rate_w[-1]) if net_rate_w else 0.0,
        "shiveringIntensity": float(shiver_intensity[-1]) if shiver_intensity else 0.0,
        "sweatingIntensity": float(sweat_intensity[-1]) if sweat_intensity else 0.0,
        "shiveringHeatProductionWatts": (
            float(shivering_heat_w[-1]) if shivering_heat_w else 0.0
        ),
        "shiveringModelCapacityPercent": (
            float(shivering_capacity_percent[-1]) if shivering_capacity_percent else 0.0
        ),
        "shiveringRmrMultiple": (
            float(shivering_rmr_multiple[-1]) if shivering_rmr_multiple else 0.0
        ),
        "sweatEvaporationRateGPerH": (
            float(sweat_evaporation_rate_g_per_h[-1])
            if sweat_evaporation_rate_g_per_h
            else 0.0
        ),
        "cumulativeSweatEvaporatedMl": (
            float(cumulative_sweat_evaporated_ml[-1])
            if cumulative_sweat_evaporated_ml
            else 0.0
        ),
        "skinWettednessPercent": (
            float(skin_wettedness_percent[-1]) if skin_wettedness_percent else 0.0
        ),
        "vasoconstrictionIntensity": float(vaso_i[-1]) if vaso_i else 0.0,
        "vasodilationIntensity": float(dilate_i[-1]) if dilate_i else 0.0,
        "deltaTrC": float(condition_history["radiantTemp"][-1])
        - float(condition_history["airTemp"][-1]),
        "shiveringActivityScale": float(
            condition_history["shiveringActivityScale"][-1]
        ),
        "shiveringSuppressionCoeff": float(
            condition_history["shiveringSuppressionCoeff"][-1]
        ),
        "shiveringWorkWatts": float(condition_history["shiveringWorkWatts"][-1]),
        "shiveringThresholdShiftC": float(
            condition_history["shiveringThresholdShiftC"][-1]
        ),
        "shiveringTemperatureScale": float(
            condition_history["shiveringTemperatureScale"][-1]
        ),
        "shiveringFatigueScale": float(condition_history["shiveringFatigueScale"][-1]),
        "shiveringFatigueLoad": float(condition_history["shiveringFatigueLoad"][-1]),
        "shiveringMaxWatts": float(fatigue_state.max_shivering_w),
        "shiveringConsumedEnergyKJ": float(fatigue_state.consumed_energy_j / 1000.0),
        "effectiveShiveringScale": float(
            condition_history["effectiveShiveringScale"][-1]
        ),
        "mediumThermalConductivityWmK": float(
            condition_history["mediumThermalConductivity"][-1]
        ),
        "mediumHcScale": float(condition_history["mediumHcScale"][-1]),
    }
    averages = {
        "heatProductionWatts": _average(met_w),
        "solarHeatGainWatts": _average(solar_gain_w),
        "heatLossResp": _average(res_w),
        "heatLossDry": _average(dry_loss_w),
        "sweatingHeatLoss": _average(sweat_loss_w),
        "skinLatentHeatLoss": _average(skin_latent_loss_w),
        "netRate": _average(net_rate_w),
    }
    vaso_active = bool(
        final_state["vasoconstrictionIntensity"] >= 10.0
        and final_state["vasoconstrictionIntensity"]
        > final_state["vasodilationIntensity"]
    )
    dilate_active = bool(
        final_state["vasodilationIntensity"] >= 10.0
        and final_state["vasodilationIntensity"]
        > final_state["vasoconstrictionIntensity"]
    )
    shiver_active = bool(final_state["shiveringIntensity"] >= 5.0)
    sweat_active = bool(final_state["sweatingIntensity"] >= 10.0)
    data_history = {
        "time": time_min,
        "coreTemp": core_temp,
        "skinTemp": skin_temp,
        "heatProduction": met_w,
        "solarGain": solar_gain_w,
        "respiratoryLoss": res_w,
        "dryLoss": dry_loss_w,
        "sweatLoss": sweat_loss_w,
        "skinLatentLoss": skin_latent_loss_w,
        "netRate": net_rate_w,
        "totalGain": total_gain_w,
        "totalLoss": total_loss_w,
        "shiveringIntensity": shiver_intensity,
        "sweatingIntensity": sweat_intensity,
        "shiveringHeatProductionWatts": shivering_heat_w,
        "shiveringModelCapacityPercent": shivering_capacity_percent,
        "shiveringRmrMultiple": shivering_rmr_multiple,
        "sweatEvaporationRateGPerH": sweat_evaporation_rate_g_per_h,
        "cumulativeSweatEvaporatedMl": cumulative_sweat_evaporated_ml,
        "skinWettednessPercent": skin_wettedness_percent,
        "vasoconstrictionIntensity": vaso_i,
        "vasodilationIntensity": dilate_i,
        "instantComfortScore": instant_comfort_series,
        "comfortScore": comfort_series,
        "totalSkinLoss": thl_sk_w,
    }
    data_history.update(condition_history)

    regional_metrics = {
        "regionIds": list(JOS3_REGION_SUFFIXES),
        "jos3RegionSuffixes": list(JOS3_REGION_SUFFIXES),
        "units": {
            "Tsk": "degC",
            "Tcr": "degC",
            "Wet": "fraction",
            "BFsk": "L/h",
            "Mshiv": "W",
            "Esweat": "W",
            "THLsk": "W",
            "Icl": "clo",
        },
        "Tsk": _regional_matrix(raw_results, "Tsk"),
        "Tcr": _regional_matrix(raw_results, "Tcr"),
        "Wet": _regional_matrix(raw_results, "Wet"),
        "BFsk": _regional_matrix(raw_results, "BFsk"),
        "Mshiv": _regional_matrix(raw_results, "Mshiv"),
        "Esweat": _regional_matrix(raw_results, "Esweat"),
        "THLsk": _regional_matrix(raw_results, "THLsk"),
        "Icl": [list(row) for row in condition_history["icl17"]],
    }

    stage_summaries: List[Dict[str, Any]] = []
    for stage_range in stage_ranges:
        result_start = stage_range["resultStartIndex"]
        result_end = stage_range["resultEndIndex"]
        if result_start is None or result_end is None:
            result_indices: slice | List[int] = []
            final_index = stage_range["startMinute"]
        else:
            result_indices = slice(result_start, result_end + 1)
            final_index = result_end

        def stage_values(key: str) -> List[float]:
            if isinstance(result_indices, list):
                return []
            return [float(value) for value in data_history[key][result_indices]]

        stage_core = stage_values("coreTemp")
        stage_skin = stage_values("skinTemp")
        stage_net = stage_values("netRate")
        stage_comfort = stage_values("instantComfortScore")
        stage_summaries.append(
            {
                **stage_range,
                "sampleCount": len(stage_core),
                "averages": {
                    "coreTempC": _average(stage_core),
                    "skinTempC": _average(stage_skin),
                    "netRateW": _average(stage_net),
                    "comfortScore": _average(stage_comfort),
                },
                "extrema": {
                    "coreTempMinC": min(stage_core) if stage_core else None,
                    "coreTempMaxC": max(stage_core) if stage_core else None,
                    "skinTempMinC": min(stage_skin) if stage_skin else None,
                    "skinTempMaxC": max(stage_skin) if stage_skin else None,
                },
                "final": {
                    "timeMin": float(time_min[final_index]),
                    "coreTempC": float(core_temp[final_index]),
                    "skinTempC": float(skin_temp[final_index]),
                    "netRateW": float(net_rate_w[final_index]),
                    "comfortScore": float(comfort_series[final_index]),
                },
            }
        )

    return {
        "schemaVersion": SCENARIO_SCHEMA_VERSION,
        "scenario": _canonical_scenario(config),
        "timelineSemantics": {
            "initialStateIndex": 0,
            "stageIntervals": "[startMinute, endMinute)",
            "stageResultRows": "resultStartIndex through resultEndIndex, inclusive",
            "profileSampling": (
                "The initial row uses each first-stage profile start. "
                "Each simulated minute uses one profile sample. "
                "The first and last minute use start and end when duration exceeds one."
            ),
        },
        "stageRanges": stage_ranges,
        "stageSummaries": stage_summaries,
        "regionalMetrics": regional_metrics,
        "finalTemp": float(core_temp[-1]) if core_temp else subject.base_core_temp_c,
        "coreTemp": float(subject.base_core_temp_c),
        "finalSkinTemp": float(skin_temp[-1]) if skin_temp else 0.0,
        "comfortScore": float(comfort_series[-1]) if comfort_series else 0.0,
        "vasoActive": vaso_active,
        "dilateActive": dilate_active,
        "shiverActive": shiver_active,
        "sweatActive": sweat_active,
        "finalState": final_state,
        "averages": averages,
        "dataHistory": data_history,
        "jos3": {"version": getattr(jos3, "__version__", None), "results": raw_results},
    }


__all__ = [
    "MAX_SCENARIO_DURATION_MIN",
    "SCENARIO_CONTRACT",
    "SCENARIO_SCHEMA_VERSION",
    "simulate_scenario",
    "validate_scenario",
    "_json_sanitize",
    "jos3",
]
