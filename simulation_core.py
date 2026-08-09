from __future__ import annotations

import contextvars
import math
from typing import Any, Dict, List

import numpy as np

import jos3


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


def _parse_icl17(payload: Dict[str, Any]) -> np.ndarray:
    icl17 = payload.get("icl17")
    if not isinstance(icl17, (list, tuple, np.ndarray)) or len(icl17) != 17:
        raise ValueError("icl17 must be a 17-length array in JOS-3 segment order")

    values = []
    for value in icl17:
        try:
            number = float(0.0 if value is None else value)
        except (TypeError, ValueError):
            number = 0.0
        if not math.isfinite(number) or number < 0.0:
            number = 0.0
        values.append(number)
    return np.asarray(values, dtype=float)


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
        return float(sum(value * weight for value, weight in zip(values, weights)) / sum(weights))

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


def simulate_jos3(payload: Dict[str, Any]) -> Dict[str, Any]:
    medium_k_raw = payload.get(
        "medium_thermal_conductivity_w_mk",
        payload.get("medium_k_w_mk", AIR_THERMAL_CONDUCTIVITY_W_MK),
    )
    try:
        medium_k_w_mk = float(medium_k_raw)
    except (TypeError, ValueError):
        medium_k_w_mk = AIR_THERMAL_CONDUCTIVITY_W_MK
    if not math.isfinite(medium_k_w_mk) or medium_k_w_mk <= 0.0:
        medium_k_w_mk = AIR_THERMAL_CONDUCTIVITY_W_MK
    medium_hc_scale = medium_k_w_mk / AIR_THERMAL_CONDUCTIVITY_W_MK

    sex = payload.get("sex") or payload.get("gender") or "female"
    sex = "female" if str(sex).lower().startswith("f") else "male"
    height_cm = float(payload["height_cm"])
    weight_kg = float(payload["weight_kg"])
    age_years = int(payload["age_years"])
    base_core_temp_c = float(payload.get("base_core_temp_c", 36.6))
    met = float(payload.get("activity_met", payload.get("met", 1.2)))
    air_temp_c = float(payload["air_temp_c"])
    wind_ms = float(payload["wind_speed_ms"])
    rh_percent = float(payload["rh_percent"])
    solar_wm2 = float(payload.get("solar_radiation_wm2", payload.get("solar_wm2", 0.0)) or 0.0)
    duration_min = max(0, min(int(payload["duration_min"]), 24 * 60))
    posture = payload.get("posture") or "standing"
    if posture not in ("standing", "sitting", "lying"):
        posture = "standing"

    icl17 = _parse_icl17(payload)
    regional_clo = _icl17_to_regional_clo(icl17)
    delta_tr_c = (solar_wm2 * SOLAR_EFFECTIVE_FACTOR) / HR_W_M2K
    bsa = _bsa_m2(height_cm, weight_kg)
    fat_pct = _body_fat_percent(sex, height_cm, weight_kg, age_years)
    _simulation_context.set({
        "shivering_scale": 1.0,
        "medium_hc_scale": float(medium_hc_scale),
    })

    model = jos3.JOS3(
        height=height_cm / 100.0,
        weight=weight_kg,
        fat=fat_pct,
        age=age_years,
        sex=sex,
        ex_output=["Tcb", "BFsk", "Mshiv", "Esweat"],
    )
    model.Ta = air_temp_c
    model.Tr = air_temp_c + delta_tr_c
    model.RH = rh_percent
    model.Va = wind_ms
    model.posture = posture
    model.Icl = np.asarray(icl17, dtype=float)

    desired_w_m2 = met * 58.2
    model.PAR = float(_clamp(desired_w_m2 / float(model.BMR), 0.8, 12.0))
    m_work_w = max(0.0, (met - 1.0) * 58.2 * bsa)
    try:
        m_threshold_w = float(payload.get("shivering_suppression_threshold_w", DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W))
    except (TypeError, ValueError):
        m_threshold_w = DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W
    if not math.isfinite(m_threshold_w) or m_threshold_w <= 0.0:
        m_threshold_w = DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W
    activity_suppression = min(1.0, m_work_w / m_threshold_w)
    shiv_scale = _clamp(1.0 - activity_suppression, 0.0, 1.0)

    model.options["shivering_activity_scale"] = float(shiv_scale)
    model.options["shivering_activity_suppression_coeff"] = float(activity_suppression)
    model.options["shivering_activity_work_w"] = float(m_work_w)
    model.options["shivering_activity_threshold_w"] = float(m_threshold_w)

    max_shivering_energy_j = 3.3e6
    consumed_shivering_energy_j = 0.0
    _simulation_context.set({"shivering_scale": float(shiv_scale), "medium_hc_scale": float(medium_hc_scale)})
    for _step in range(duration_min):
        current_tcb = _latest_tcb(model, base_core_temp_c)
        if 34.0 <= current_tcb <= 37.2:
            f_temp = 1.0
        elif current_tcb < 34.0:
            f_temp = max(0.0, (current_tcb - 30.0) / 4.0)
        else:
            f_temp = max(0.0, 1.0 - (current_tcb - 37.2) / 0.8)

        consumed_shivering_energy_j += _latest_shivering_w(model) * 60.0
        f_fatigue = max(0.0, 1.0 - consumed_shivering_energy_j / max_shivering_energy_j)
        _simulation_context.set({
            "shivering_scale": float(shiv_scale * f_temp * f_fatigue),
            "medium_hc_scale": float(medium_hc_scale),
        })
        model.simulate(times=1, dtime=60)

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

    solar_gain_w = [solar_wm2 * bsa * SOLAR_EFFECTIVE_FACTOR for _ in time_min]
    met_arr = np.asarray(met_w, dtype=float)
    res_arr = np.asarray(res_w, dtype=float)
    dry_arr = np.asarray(dry_loss_w, dtype=float)
    latent_arr = np.asarray(skin_latent_loss_w, dtype=float)
    net_rate_w = (met_arr - res_arr - dry_arr - latent_arr).tolist()
    total_gain_w = met_arr.tolist()
    total_loss_w = (res_arr + dry_arr + latent_arr).tolist()
    shiver_intensity = (100.0 * (np.asarray(mshiv_w) / np.maximum(1e-6, met_arr))).clip(0, 100).tolist()
    wet_mean = [float(x) for x in raw_results.get("WetMean", [])]
    eff_sweat = np.maximum(0.0, (np.asarray(wet_mean) - 0.06) / 0.94).clip(0, 1)
    sweat_intensity = (100.0 * eff_sweat).tolist()

    baseline_bf = float(bf_sk[0]) if bf_sk else 0.0
    if baseline_bf <= 1e-6:
        vaso_i = [0.0 for _ in time_min]
        dilate_i = [0.0 for _ in time_min]
    else:
        bf = np.asarray(bf_sk, dtype=float)
        vaso_i = (100.0 * np.maximum(0.0, (baseline_bf - bf) / baseline_bf)).clip(0, 100).tolist()
        dilate_i = (100.0 * np.maximum(0.0, (bf - baseline_bf) / baseline_bf)).clip(0, 100).tolist()

    weighted_sum = 0.0
    weight_total = 0.0
    comfort_series: List[float] = []
    for idx in range(len(time_min)):
        instant = _calculate_instant_comfort_score(
            core_t=float(core_temp[idx]),
            base_core_t=base_core_temp_c,
            skin_t=float(skin_temp[idx]),
            shiver_intensity=float(shiver_intensity[idx]),
            sweat_intensity=float(sweat_intensity[idx]),
            net_rate=float(net_rate_w[idx]),
            regional_clo=regional_clo,
        )
        weight = float(idx + 1)
        weighted_sum += instant * weight
        weight_total += weight
        comfort_series.append(weighted_sum / weight_total if weight_total else instant)

    def average(values: List[float]) -> float:
        return float(sum(values) / len(values)) if values else 0.0

    final_state = {
        "heatProductionWatts": float(met_w[-1]) if met_w else 0.0,
        "solarHeatGainWatts": float(solar_gain_w[-1]) if solar_gain_w else 0.0,
        "heatLossResp": float(res_w[-1]) if res_w else 0.0,
        "heatLossDry": float(dry_loss_w[-1]) if dry_loss_w else 0.0,
        "sweatingHeatLoss": float(sweat_loss_w[-1]) if sweat_loss_w else 0.0,
        "skinLatentHeatLoss": float(skin_latent_loss_w[-1]) if skin_latent_loss_w else 0.0,
        "netHeatRateWatts": float(net_rate_w[-1]) if net_rate_w else 0.0,
        "shiveringIntensity": float(shiver_intensity[-1]) if shiver_intensity else 0.0,
        "sweatingIntensity": float(sweat_intensity[-1]) if sweat_intensity else 0.0,
        "vasoconstrictionIntensity": float(vaso_i[-1]) if vaso_i else 0.0,
        "vasodilationIntensity": float(dilate_i[-1]) if dilate_i else 0.0,
        "deltaTrC": float(delta_tr_c),
        "shiveringActivityScale": float(shiv_scale),
        "shiveringSuppressionCoeff": float(activity_suppression),
        "shiveringWorkWatts": float(m_work_w),
        "shiveringSuppressionThresholdW": float(m_threshold_w),
        "mediumThermalConductivityWmK": float(medium_k_w_mk),
        "mediumHcScale": float(medium_hc_scale),
    }
    averages = {
        "heatProductionWatts": average(met_w),
        "solarHeatGainWatts": average(solar_gain_w),
        "heatLossResp": average(res_w),
        "heatLossDry": average(dry_loss_w),
        "sweatingHeatLoss": average(sweat_loss_w),
        "skinLatentHeatLoss": average(skin_latent_loss_w),
        "netRate": average(net_rate_w),
    }
    vaso_active = bool(final_state["vasoconstrictionIntensity"] >= 10.0 and final_state["vasoconstrictionIntensity"] > final_state["vasodilationIntensity"])
    dilate_active = bool(final_state["vasodilationIntensity"] >= 10.0 and final_state["vasodilationIntensity"] > final_state["vasoconstrictionIntensity"])
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
        "comfortScore": comfort_series,
        "totalSkinLoss": thl_sk_w,
    }
    return {
        "finalTemp": float(core_temp[-1]) if core_temp else base_core_temp_c,
        "coreTemp": float(base_core_temp_c),
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


__all__ = ["simulate_jos3", "_json_sanitize", "jos3"]
