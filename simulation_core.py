from __future__ import annotations

import contextvars
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

import numpy as np

import jos3

with Path(__file__).with_name("scenario-contract.json").open(encoding="utf-8") as file:
    SCENARIO_CONTRACT = json.load(file)

SCENARIO_SCHEMA_VERSION = int(SCENARIO_CONTRACT["schemaVersion"])
SCENARIO_LIMITS = SCENARIO_CONTRACT["limits"]
CLOTHING_SEGMENTS = tuple(SCENARIO_CONTRACT["clothingSegments"])
CLOTHING_CATEGORIES = frozenset(SCENARIO_CONTRACT["clothingCategories"])
POSTURES = frozenset(SCENARIO_CONTRACT["postures"])
CLOTHING_INSULATION = SCENARIO_CONTRACT["clothingInsulation"]
CLOTHING_SEGMENT_AREA_FRACTIONS = CLOTHING_INSULATION["segmentAreaFractions"]
BODY_TO_CLOTHING_SEGMENT = CLOTHING_INSULATION["bodyToClothingSegment"]
ISO_9920_INTERCEPT_CLO = float(CLOTHING_INSULATION["iso9920InterceptClo"])
ISO_9920_GARMENT_SUM_FACTOR = float(CLOTHING_INSULATION["iso9920GarmentSumFactor"])

_simulation_context: contextvars.ContextVar[Dict[str, float]] = contextvars.ContextVar(
    "htm_simulation_context",
    default={"shivering_scale": 1.0, "medium_hc_scale": 1.0},
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

HR_W_M2K = 4.7
SOLAR_EFFECTIVE_FACTOR = 0.12
AIR_THERMAL_CONDUCTIVITY_W_MK = 0.026
DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W = 270.0
MAX_SCENARIO_DURATION_MIN = int(SCENARIO_LIMITS["durationMin"]["maximum"])

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
    shivering_suppression_threshold_w: float


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


def _patch_jos3_shivering() -> None:
    try:
        import jos3.thermoregulation as threg
    except Exception:
        return
    if getattr(threg, "_htm_shivering_patched", False):
        return

    original = threg.shivering

    def shivering_with_activity(*args: Any, **kwargs: Any) -> Any:
        value = original(*args, **kwargs)
        scale = _simulation_context.get().get("shivering_scale", 1.0)
        return np.asarray(value, dtype=float) * float(scale)

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
    return 0.007184 * (height_cm**0.725) * (weight_kg**0.425)


def _body_fat_percent(
    gender: str, height_cm: float, weight_kg: float, age_years: int
) -> float:
    bmi = weight_kg / ((height_cm / 100.0) ** 2)
    if gender == "female":
        fat = (1.20 * bmi) + (0.23 * age_years) - 5.4
    else:
        fat = (1.20 * bmi) + (0.23 * age_years) - 16.2
    return _clamp(float(fat), 3.0, 60.0)


def _require_mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{path} must be an object")
    return value


def _number(
    value: Any,
    path: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    exclusive_minimum: bool = False,
) -> float:
    if isinstance(value, bool) or not isinstance(
        value, (int, float, np.integer, np.floating)
    ):
        raise ValueError(f"{path} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{path} must be a finite number")
    if minimum is not None:
        invalid = number <= minimum if exclusive_minimum else number < minimum
        if invalid:
            operator = "greater than" if exclusive_minimum else "at least"
            raise ValueError(f"{path} must be {operator} {minimum:g}")
    if maximum is not None and number > maximum:
        raise ValueError(f"{path} must be at most {maximum:g}")
    return number


def _integer(
    value: Any,
    path: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)):
        raise ValueError(f"{path} must be an integer")
    number = int(value)
    if minimum is not None and number < minimum:
        raise ValueError(f"{path} must be at least {minimum}")
    if maximum is not None and number > maximum:
        raise ValueError(f"{path} must be at most {maximum}")
    return number


def _bounded_number(value: Any, path: str, limit_name: str) -> float:
    limit = SCENARIO_LIMITS[limit_name]
    return _number(
        value,
        path,
        minimum=float(limit["minimum"]),
        maximum=float(limit["maximum"]),
        exclusive_minimum=bool(limit.get("exclusiveMinimum", False)),
    )


def _bounded_integer(value: Any, path: str, limit_name: str) -> int:
    limit = SCENARIO_LIMITS[limit_name]
    return _integer(
        value,
        path,
        minimum=int(limit["minimum"]),
        maximum=int(limit["maximum"]),
    )


def _non_empty_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path} must be a non-empty string")
    return value


def _profile(value: Any, path: str, limit_name: str) -> NumericProfile:
    profile = _require_mapping(value, path)
    if "start" not in profile or "end" not in profile:
        raise ValueError(f"{path} profile must contain start and end")
    start = _bounded_number(profile["start"], f"{path}.start", limit_name)
    end = _bounded_number(profile["end"], f"{path}.end", limit_name)
    return NumericProfile(start=start, end=end)


def _normalize_outfit(value: Any, path: str) -> tuple[GarmentConfig, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError(f"{path} must be an array")

    garments: List[GarmentConfig] = []
    seen_instance_ids: set[str] = set()
    for index, raw_garment in enumerate(value):
        garment_path = f"{path}[{index}]"
        garment = _require_mapping(raw_garment, garment_path)
        garment_id = _non_empty_string(garment.get("id"), f"{garment_path}.id")
        instance_id = _non_empty_string(
            garment.get("instanceId"), f"{garment_path}.instanceId"
        )
        if instance_id in seen_instance_ids:
            raise ValueError(f"{garment_path}.instanceId must be unique in the stage")
        seen_instance_ids.add(instance_id)

        category = garment.get("category")
        if not isinstance(category, str) or category not in CLOTHING_CATEGORIES:
            raise ValueError(f"{garment_path}.category is unknown")

        raw_segment_clo = _require_mapping(
            garment.get("segmentClo"), f"{garment_path}.segmentClo"
        )
        segment_clo: List[tuple[str, float]] = []
        for segment, raw_clo in raw_segment_clo.items():
            segment_path = f"{garment_path}.segmentClo.{segment}"
            if segment not in CLOTHING_SEGMENTS:
                raise ValueError(f"{segment_path} is an unknown clothing segment")
            segment_clo.append(
                (segment, _bounded_number(raw_clo, segment_path, "clothingClo"))
            )

        garments.append(
            GarmentConfig(
                id=garment_id,
                instance_id=instance_id,
                name_zh=_non_empty_string(
                    garment.get("nameZh"), f"{garment_path}.nameZh"
                ),
                name_en=_non_empty_string(
                    garment.get("nameEn"), f"{garment_path}.nameEn"
                ),
                category=str(category),
                modifier=_bounded_number(
                    garment.get("modifier"),
                    f"{garment_path}.modifier",
                    "garmentModifier",
                ),
                segment_clo=tuple(segment_clo),
            )
        )
    return tuple(garments)


def _outfit_to_icl17(
    outfit: Sequence[GarmentConfig], stage_path: str
) -> tuple[float, ...]:
    summed_regional_clo = {segment: 0.0 for segment in CLOTHING_SEGMENTS}
    for garment in outfit:
        for segment, clo in garment.segment_clo:
            summed_regional_clo[segment] += clo * garment.modifier

    garment_sum = sum(
        summed_regional_clo[segment] * float(CLOTHING_SEGMENT_AREA_FRACTIONS[segment])
        for segment in CLOTHING_SEGMENTS
    )
    if garment_sum == 0.0:
        regional_clo = summed_regional_clo
    else:
        ensemble_clo = (
            ISO_9920_INTERCEPT_CLO + ISO_9920_GARMENT_SUM_FACTOR * garment_sum
        )
        scale = ensemble_clo / garment_sum
        regional_clo = {
            segment: summed_regional_clo[segment] * scale
            for segment in CLOTHING_SEGMENTS
        }

    values = tuple(
        regional_clo[BODY_TO_CLOTHING_SEGMENT[body_segment]]
        for body_segment in SCENARIO_CONTRACT["bodySegments"]
    )
    for index, clo in enumerate(values):
        _bounded_number(clo, f"{stage_path}.icl17[{index}]", "clothingClo")
    return values


def _normalize_scenario(scenario: Mapping[str, Any]) -> ScenarioConfig:
    scenario = _require_mapping(scenario, "scenario")
    schema_version = _integer(scenario.get("schemaVersion"), "schemaVersion")
    if schema_version != SCENARIO_SCHEMA_VERSION:
        raise ValueError(
            f"schemaVersion must be {SCENARIO_SCHEMA_VERSION}; received {schema_version}"
        )

    scenario_name = _non_empty_string(scenario.get("name"), "name")
    subject_value = _require_mapping(scenario.get("subject"), "subject")
    sex_value = subject_value.get("sex")
    if not isinstance(sex_value, str) or sex_value not in {"female", "male"}:
        raise ValueError("subject.sex must be 'female' or 'male'")
    subject = SubjectConfig(
        sex=str(sex_value),
        height_cm=_bounded_number(
            subject_value.get("heightCm"), "subject.heightCm", "heightCm"
        ),
        weight_kg=_bounded_number(
            subject_value.get("weightKg"), "subject.weightKg", "weightKg"
        ),
        age_years=_bounded_integer(
            subject_value.get("ageYears"), "subject.ageYears", "ageYears"
        ),
        base_core_temp_c=_bounded_number(
            subject_value.get("referenceCoreTempC"),
            "subject.referenceCoreTempC",
            "referenceCoreTempC",
        ),
    )

    stages_value = scenario.get("stages")
    if not isinstance(stages_value, Sequence) or isinstance(stages_value, (str, bytes)):
        raise ValueError("stages must be an array")
    if not stages_value:
        raise ValueError("stages must contain at least one stage")

    stages: List[StageConfig] = []
    seen_ids: set[str] = set()
    total_duration = 0
    for index, raw_stage in enumerate(stages_value):
        path = f"stages[{index}]"
        stage_value = _require_mapping(raw_stage, path)
        stage_id = _non_empty_string(stage_value.get("id"), f"{path}.id")
        name = _non_empty_string(stage_value.get("name"), f"{path}.name")
        if stage_id in seen_ids:
            raise ValueError(f"{path}.id must be unique")
        seen_ids.add(stage_id)

        duration_min = _bounded_integer(
            stage_value.get("durationMin"), f"{path}.durationMin", "durationMin"
        )
        total_duration += duration_min
        if total_duration > MAX_SCENARIO_DURATION_MIN:
            raise ValueError(
                f"scenario duration must not exceed {MAX_SCENARIO_DURATION_MIN} minutes"
            )

        environment = _require_mapping(
            stage_value.get("environment"), f"{path}.environment"
        )
        posture = stage_value.get("posture")
        if not isinstance(posture, str) or posture not in POSTURES:
            raise ValueError(
                f"{path}.posture must be 'standing', 'sitting', or 'lying'"
            )
        outfit = _normalize_outfit(stage_value.get("outfit"), f"{path}.outfit")
        stages.append(
            StageConfig(
                id=stage_id,
                name=name,
                duration_min=duration_min,
                air_temp_c=_profile(
                    environment.get("airTempC"),
                    f"{path}.environment.airTempC",
                    "airTempC",
                ),
                wind_speed_ms=_profile(
                    environment.get("windSpeedMs"),
                    f"{path}.environment.windSpeedMs",
                    "windSpeedMs",
                ),
                rh_percent=_profile(
                    environment.get("relativeHumidityPercent"),
                    f"{path}.environment.relativeHumidityPercent",
                    "relativeHumidityPercent",
                ),
                solar_radiation_wm2=_profile(
                    environment.get("solarRadiationWm2"),
                    f"{path}.environment.solarRadiationWm2",
                    "solarRadiationWm2",
                ),
                medium_thermal_conductivity_w_mk=_profile(
                    environment.get("mediumThermalConductivityWmK"),
                    f"{path}.environment.mediumThermalConductivityWmK",
                    "mediumThermalConductivityWmK",
                ),
                activity_met=_profile(
                    stage_value.get("activityMet"),
                    f"{path}.activityMet",
                    "activityMet",
                ),
                posture=str(posture),
                outfit=outfit,
                icl17=_outfit_to_icl17(outfit, path),
            )
        )

    return ScenarioConfig(
        name=scenario_name,
        subject=subject,
        stages=tuple(stages),
        shivering_suppression_threshold_w=DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W,
    )


def _icl17_to_regional_clo(icl17: np.ndarray) -> Dict[str, float]:
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


def _temperature_shivering_scale(core_temp_c: float) -> float:
    if 34.0 <= core_temp_c <= 37.2:
        return 1.0
    if core_temp_c < 34.0:
        return max(0.0, (core_temp_c - 30.0) / 4.0)
    return max(0.0, 1.0 - (core_temp_c - 37.2) / 0.8)


def _activity_state(
    activity_met: float,
    bsa_m2: float,
    suppression_threshold_w: float,
) -> ActivityState:
    work_w = max(0.0, (activity_met - 1.0) * 58.2 * bsa_m2)
    suppression = min(1.0, work_w / suppression_threshold_w)
    return ActivityState(
        work_w=work_w,
        suppression=suppression,
        scale=_clamp(1.0 - suppression, 0.0, 1.0),
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
    suppression_threshold_w: float,
) -> ActivityState:
    model.Ta = conditions.air_temp_c
    model.Tr = conditions.radiant_temp_c
    model.RH = conditions.rh_percent
    model.Va = conditions.wind_speed_ms
    model.posture = conditions.posture
    model.Icl = np.asarray(conditions.icl17, dtype=float)

    model.PAR = float(
        _clamp((conditions.activity_met * 58.2) / float(model.BMR), 0.8, 12.0)
    )
    activity = _activity_state(
        conditions.activity_met,
        bsa_m2,
        suppression_threshold_w,
    )
    model.options["shivering_activity_scale"] = activity.scale
    model.options["shivering_activity_suppression_coeff"] = activity.suppression
    model.options["shivering_activity_work_w"] = activity.work_w
    model.options["shivering_activity_threshold_w"] = suppression_threshold_w
    return activity


def _append_condition_sample(
    history: Dict[str, List[Any]],
    stage: StageConfig,
    conditions: StageSample,
    activity: ActivityState,
    *,
    temperature_scale: float,
    fatigue_scale: float,
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
        "shiveringTemperatureScale": temperature_scale,
        "shiveringFatigueScale": fatigue_scale,
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
    initial_activity = _apply_conditions(
        model,
        initial_conditions,
        bsa_m2=bsa,
        suppression_threshold_w=config.shivering_suppression_threshold_w,
    )
    initial_temperature_scale = _temperature_shivering_scale(
        _latest_tcb(model, subject.base_core_temp_c)
    )
    _simulation_context.set(
        {
            "shivering_scale": initial_activity.scale * initial_temperature_scale,
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
        fatigue_scale=1.0,
    )

    stage_ranges: List[Dict[str, Any]] = []
    elapsed_min = 0
    max_shivering_energy_j = 3.3e6
    consumed_shivering_energy_j = 0.0
    for stage_index, stage in enumerate(config.stages):
        start_min = elapsed_min
        for step in range(stage.duration_min):
            conditions = _sample_stage(stage, step)
            activity = _apply_conditions(
                model,
                conditions,
                bsa_m2=bsa,
                suppression_threshold_w=config.shivering_suppression_threshold_w,
            )
            consumed_shivering_energy_j += _latest_shivering_w(model) * 60.0
            fatigue_scale = max(
                0.0,
                1.0 - (consumed_shivering_energy_j / max_shivering_energy_j),
            )
            temperature_scale = _temperature_shivering_scale(
                _latest_tcb(model, subject.base_core_temp_c)
            )
            effective_shivering_scale = (
                activity.scale * temperature_scale * fatigue_scale
            )
            _simulation_context.set(
                {
                    "shivering_scale": effective_shivering_scale,
                    "medium_hc_scale": conditions.medium_hc_scale,
                }
            )
            model.simulate(times=1, dtime=60)
            _append_condition_sample(
                condition_history,
                stage,
                conditions,
                activity,
                temperature_scale=temperature_scale,
                fatigue_scale=fatigue_scale,
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
    shiver_intensity = (
        (100.0 * (np.asarray(mshiv_w) / np.maximum(1e-6, met_arr)))
        .clip(0, 100)
        .tolist()
    )
    wet_mean = [float(x) for x in raw_results.get("WetMean", [])]
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
        "shiveringSuppressionThresholdW": float(
            config.shivering_suppression_threshold_w
        ),
        "shiveringFatigueScale": float(condition_history["shiveringFatigueScale"][-1]),
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
    "SCENARIO_SCHEMA_VERSION",
    "simulate_scenario",
    "_json_sanitize",
    "jos3",
]
