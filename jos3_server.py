from __future__ import annotations

import argparse
import json
import math
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Tuple


import numpy as np

import jos3

_thread_context = threading.local()


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
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

HR_W_M2K = 4.7
SOLAR_EFFECTIVE_FACTOR = 0.12  # Converts W/m2 solar -> effective absorbed W/m2 on body

# Reference thermal conductivity of air near room temperature [W/m.K].
# Used to scale convective heat transfer when simulating other media.
AIR_THERMAL_CONDUCTIVITY_W_MK = 0.026

# Tikuisis et al. cold-water exercise studies suggest full shivering suppression
# around extra metabolic heat production ~250–300 W. Default: 270 W.
DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W = 270.0


def _patch_jos3_shivering() -> None:
    try:
        import jos3.thermoregulation as threg
    except Exception:
        return
    if getattr(threg, "_htm_shivering_patched", False):
        return

    orig = threg.shivering

    def shivering_with_activity(*args: Any, **kwargs: Any) -> Any:
        mshiv = orig(*args, **kwargs)
        scale = getattr(_thread_context, "shivering_scale", 1.0)

        return np.asarray(mshiv, dtype=float) * scale

    threg.shivering = shivering_with_activity
    threg._htm_shivering_patched = True


_patch_jos3_shivering()


def _patch_jos3_fixed_hc() -> None:
    """Scale JOS-3 convective coefficient by a per-request medium conductivity factor.

    Note: JOS-3 normalizes local hc values via thermoregulation.fixed_hc(), so
    scaling conv_coef() itself would be cancelled out. We scale after fixed_hc().
    """
    try:
        import jos3.thermoregulation as threg
    except Exception:
        return
    if getattr(threg, "_htm_fixed_hc_patched", False):
        return

    orig = threg.fixed_hc

    def fixed_hc_with_medium(*args: Any, **kwargs: Any) -> Any:
        hc = orig(*args, **kwargs)
        scale = getattr(_thread_context, "medium_hc_scale", 1.0)
        return np.asarray(hc, dtype=float) * float(scale)

    threg.fixed_hc = fixed_hc_with_medium
    threg._htm_fixed_hc_patched = True


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
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return math.sqrt(var)


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
    # Ported from index.html calculateInstantComfortScore.
    temp_diff = core_t - base_core_t
    ideal_skin_lo = 32.0
    ideal_skin_hi = 34.0

    skin_dev = 0.0
    if skin_t < ideal_skin_lo:
        skin_dev = ideal_skin_lo - skin_t
    elif skin_t > ideal_skin_hi:
        skin_dev = skin_t - ideal_skin_hi

    p_core = abs(temp_diff) * 35.0

    p_skin = 0.0
    if skin_t < ideal_skin_lo:
        p_skin = skin_dev * 8.0
    elif skin_t > ideal_skin_hi:
        p_skin = skin_dev * 6.0

    p_response = (shiver_intensity + sweat_intensity) * 0.35
    p_net = abs(net_rate) * 0.15

    primary = p_core + p_skin + p_response

    normalized = []
    for region in BODY_REGIONS.keys():
        base_clo = float(regional_clo.get(region, 0.0) or 0.0)
        denom = float(IDEAL_CLO_RATIOS.get(region, 1.0) or 1.0)
        normalized.append(base_clo / denom)

    clo_std = _stddev(normalized)
    raw_imbalance = clo_std * 50.0
    modulation = max(0.0, 1.0 - (primary / 40.0))
    imbalance_penalty = raw_imbalance * modulation

    score = 100.0 - p_core - p_skin - p_response - p_net - imbalance_penalty
    return _clamp(score, 0.0, 100.0)


def _bsa_m2(height_cm: float, weight_kg: float) -> float:
    # DuBois, same as index.html
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

    out = []
    for v in icl17:
        try:
            f = float(0.0 if v is None else v)
        except (TypeError, ValueError):
            f = 0.0
        if not math.isfinite(f) or f < 0.0:
            f = 0.0
        out.append(f)
    return np.asarray(out, dtype=float)


def _icl17_to_regional_clo(icl17: np.ndarray) -> Dict[str, float]:
    a_head, a_neck = 0.055, 0.015
    a_chest, a_back, a_pelvis = 0.12, 0.12, 0.11
    a_shoulder, a_arm = 0.04, 0.10
    a_thigh, a_leg = 0.18, 0.14

    head = float(icl17[0])
    neck = float(icl17[1])
    chest = float(icl17[2])
    back = float(icl17[3])
    pelvis = float(icl17[4])

    shoulder = 0.5 * (float(icl17[5]) + float(icl17[8]))
    arm = 0.5 * (float(icl17[6]) + float(icl17[9]))
    hand = 0.5 * (float(icl17[7]) + float(icl17[10]))

    thigh = 0.5 * (float(icl17[11]) + float(icl17[14]))
    leg = 0.5 * (float(icl17[12]) + float(icl17[15]))
    foot = 0.5 * (float(icl17[13]) + float(icl17[16]))

    # Area-weighted averages within each coarse region.
    head_reg = (head * a_head + neck * a_neck) / (a_head + a_neck)
    torso_reg = (chest * a_chest + back * a_back + pelvis * a_pelvis) / (
        a_chest + a_back + a_pelvis
    )
    arms_reg = (shoulder * a_shoulder + arm * a_arm) / (a_shoulder + a_arm)
    legs_reg = (thigh * a_thigh + leg * a_leg) / (a_thigh + a_leg)

    return {
        "head": float(head_reg),
        "torso": float(torso_reg),
        "arms": float(arms_reg),
        "hands": float(hand),
        "legs": float(legs_reg),
        "feet": float(foot),
    }


def _sum_segments(d: Dict[str, List[float]], prefix: str) -> List[float]:
    keys = [k for k in d.keys() if k.startswith(prefix)]
    keys.sort()
    if not keys:
        return [0.0 for _ in range(len(d.get("ModTime", [])))]
    arr = np.zeros(len(d[keys[0]]), dtype=float)
    for k in keys:
        arr += np.asarray(d[k], dtype=float)
    return arr.tolist()


def _sanitize_jos3_results(d: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, series in d.items():
        if not isinstance(series, (list, tuple, np.ndarray)):
            continue
        vals: List[Any] = []
        for v in series:
            if hasattr(v, "total_seconds"):
                vals.append(float(v.total_seconds()))
            else:
                vals.append(_json_sanitize(v))
        out[str(k)] = vals
    return out


def simulate_jos3(payload: Dict[str, Any]) -> Dict[str, Any]:
    # Default medium is air. Let callers override the medium thermal conductivity,
    # which we approximate by scaling the convective coefficient h ~ k.
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
    _thread_context.medium_hc_scale = float(medium_hc_scale)

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
    solar_wm2 = float(
        payload.get("solar_radiation_wm2", payload.get("solar_wm2", 0.0)) or 0.0
    )
    duration_min = int(payload["duration_min"])

    posture = payload.get("posture") or "standing"
    if posture not in ("standing", "sitting", "lying"):
        posture = "standing"

    icl17 = _parse_icl17(payload)
    regional_clo = _icl17_to_regional_clo(icl17)

    # Solar: approximate by raising mean radiant temperature by an equivalent delta.
    delta_tr_c = (solar_wm2 * SOLAR_EFFECTIVE_FACTOR) / HR_W_M2K
    tr_c = air_temp_c + delta_tr_c

    fat_pct = _body_fat_percent(sex, height_cm, weight_kg, age_years)

    model = jos3.JOS3(
        height=height_cm / 100.0,
        weight=weight_kg,
        fat=fat_pct,
        age=age_years,
        sex=sex,
        ex_output=[
            "Tcb",
            "BFsk",
            "Mshiv",
            "Esweat",
        ],  # for core temp + intensity heuristics
    )

    # Uniform environment (accepts scalar which expands to 17 segments).
    model.Ta = air_temp_c
    model.Tr = tr_c
    model.RH = rh_percent
    model.Va = wind_ms
    model.posture = posture

    model.Icl = np.asarray(icl17, dtype=float)

    # UI uses met (1 met = 58.2 W/m2). JOS3 uses PAR as MetabolicRate/BMR.
    desired_w_m2 = met * 58.2
    par = desired_w_m2 / float(model.BMR)
    model.PAR = float(_clamp(par, 0.8, 12.0))

    # Activity-dependent shivering suppression:
    #   C_activity = min(1, M_work / M_threshold)
    #   M_actual_shivering = M_shivering_calc * (1 - C_activity)
    #
    # Here we treat M_work as the net exercise heat production above 1 MET
    # resting, in Watts.
    bsa = _bsa_m2(height_cm, weight_kg)
    m_work_w = max(0.0, (met - 1.0) * 58.2 * bsa)

    m_threshold_w = float(
        payload.get(
            "shivering_suppression_threshold_w", DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W
        )
    )
    if not math.isfinite(m_threshold_w) or m_threshold_w <= 0.0:
        m_threshold_w = DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W

    c_activity = min(1.0, m_work_w / m_threshold_w) if m_threshold_w > 0 else 1.0
    shiv_scale = float(_clamp(1.0 - c_activity, 0.0, 1.0))
    # Passed through to our runtime patch of jos3.thermoregulation.shivering.
    model.options["shivering_activity_scale"] = shiv_scale
    model.options["shivering_activity_suppression_coeff"] = float(
        _clamp(c_activity, 0.0, 1.0)
    )
    model.options["shivering_activity_work_w"] = float(m_work_w)
    model.options["shivering_activity_threshold_w"] = float(m_threshold_w)

    # Run in 60s steps to match the UI timeline.
    # Step forward minute-by-minute so duration can reduce shivering capacity
    # via hypothermia and fatigue suppression.
    #
    # Define a maximum "shivering energy budget".
    # 800 kcal ~= 3,347,200 J.
    max_shivering_energy_j = 3.3e6
    consumed_shivering_energy_j = 0.0

    duration_min = max(0, min(duration_min, 24 * 60))

    for _step in range(duration_min):
        # 1) Get current core temperature (Tcb: central blood pool temperature).
        # If this is the first step, fall back to the requested baseline.
        current_results = model.dict_results()
        if "Tcb" in current_results and len(current_results["Tcb"]) > 0:
            current_tcb = float(current_results["Tcb"][-1])
        else:
            current_tcb = base_core_temp_c

        # 2) Hypothermia suppression factor based on core temp.
        if 34.0 <= current_tcb <= 37.2:
            f_temp = 1.0
        elif current_tcb < 34.0:
            f_temp = max(0.0, (current_tcb - 30.0) / (34.0 - 30.0))
        else:
            f_temp = max(0.0, 1.0 - (current_tcb - 37.2) / (38.0 - 37.2))

        # 3) Fatigue factor from cumulative shivering energy.
        # JOS3 segmented output keys like MshivHead, MshivChest, etc.
        last_mshiv_w = 0.0
        for k, series in current_results.items():
            if k.startswith("Mshiv") and len(series) > 0:
                last_mshiv_w += float(series[-1])

        consumed_shivering_energy_j += last_mshiv_w * 60.0
        f_fatigue = max(
            0.0, 1.0 - (consumed_shivering_energy_j / max_shivering_energy_j)
        )

        # 4) Inject combined suppression into options for the runtime shivering patch.
        _thread_context.shivering_scale = float(shiv_scale * f_temp * f_fatigue)

        # 5) Advance simulation by 1 minute.
        model.simulate(times=1, dtime=60)

    # After stepping, fetch complete results.
    d = model.dict_results()

    raw_results = _sanitize_jos3_results(d)
    # Convert time axis from seconds to minutes for charting.
    time_sec = raw_results.get("ModTime", [])
    time_min = (np.asarray(time_sec, dtype=float) / 60.0).tolist() if time_sec else []
    core_temp = [float(x) for x in raw_results.get("Tcb", [])]
    skin_temp = [float(x) for x in raw_results.get("TskMean", [])]
    met_w = [float(x) for x in raw_results.get("Met", [])]
    res_w = [float(x) for x in raw_results.get("RES", [])]

    # Use raw_results (already float lists) for aggregation.
    dry_loss_w = _sum_segments(raw_results, "SHLsk")
    # JOS-3's LHLsk is total skin latent heat loss (sweating + diffuse/insensible).
    # Esweat is latent heat loss due to only sweating.
    skin_latent_loss_w = _sum_segments(raw_results, "LHLsk")
    sweat_loss_w = _sum_segments(raw_results, "Esweat")
    thl_sk_w = _sum_segments(raw_results, "THLsk")
    bf_sk = _sum_segments(raw_results, "BFsk")
    mshiv_w = _sum_segments(raw_results, "Mshiv")

    # Solar is informational for the UI; the physics is represented via Tr adjustment above.
    solar_gain_w = [solar_wm2 * bsa * SOLAR_EFFECTIVE_FACTOR for _ in time_min]

    net_rate_w = (
        np.asarray(met_w)
        - np.asarray(res_w)
        - np.asarray(dry_loss_w)
        - np.asarray(skin_latent_loss_w)
    ).tolist()

    total_gain_w = np.asarray(met_w, dtype=float).tolist()
    total_loss_w = (
        np.asarray(res_w) + np.asarray(dry_loss_w) + np.asarray(skin_latent_loss_w)
    ).tolist()

    # Intensities.
    shiver_intensity = (
        (100.0 * (np.asarray(mshiv_w) / np.maximum(1e-6, np.asarray(met_w))))
        .clip(0, 100)
        .tolist()
    )
    # WetMean includes a baseline 0.06 from diffuse/insensible evaporation.
    # Convert it to "active sweating" fraction (0..1): (wet - 0.06) / 0.94.
    wet_mean = [float(x) for x in raw_results.get("WetMean", [])]
    eff_sweat = (
        np.maximum(0.0, (np.asarray(wet_mean, dtype=float) - 0.06) / 0.94)
    ).clip(0, 1)
    sweat_intensity = (100.0 * eff_sweat).tolist()

    # Use BFsk changes as a crude vasomotor indicator.
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

    # Comfort score
    weighted_sum = 0.0
    weight_total = 0.0
    comfort_series: List[float] = []
    for idx in range(len(time_min)):
        inst = _calculate_instant_comfort_score(
            core_t=float(core_temp[idx]),
            base_core_t=base_core_temp_c,
            skin_t=float(skin_temp[idx]),
            shiver_intensity=float(shiver_intensity[idx]),
            sweat_intensity=float(sweat_intensity[idx]),
            net_rate=float(net_rate_w[idx]),
            regional_clo=regional_clo,
        )
        w = float(idx + 1)
        weighted_sum += inst * w
        weight_total += w
        comfort_series.append(weighted_sum / weight_total if weight_total else inst)

    def avg(xs: List[float]) -> float:
        return float(sum(xs) / len(xs)) if xs else 0.0

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
        "deltaTrC": float(delta_tr_c),
        "shiveringActivityScale": float(
            model.options.get("shivering_activity_scale", 1.0)
        ),
        "shiveringSuppressionCoeff": float(
            model.options.get("shivering_activity_suppression_coeff", 0.0)
        ),
        "shiveringWorkWatts": float(
            model.options.get("shivering_activity_work_w", 0.0)
        ),
        "shiveringSuppressionThresholdW": float(
            model.options.get(
                "shivering_activity_threshold_w", DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W
            )
        ),
        "mediumThermalConductivityWmK": float(medium_k_w_mk),
        "mediumHcScale": float(medium_hc_scale),
    }

    averages = {
        "heatProductionWatts": avg(met_w),
        "solarHeatGainWatts": avg(solar_gain_w),
        "heatLossResp": avg(res_w),
        "heatLossDry": avg(dry_loss_w),
        "sweatingHeatLoss": avg(sweat_loss_w),
        "skinLatentHeatLoss": avg(skin_latent_loss_w),
        "netRate": avg(net_rate_w),
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
        "comfortScore": comfort_series,
        # Extra series for debugging / future UI use:
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
        "jos3": {
            "version": getattr(jos3, "__version__", None),
            "results": raw_results,
        },
    }


class Handler(BaseHTTPRequestHandler):
    _cache: Dict[str, Tuple[int, str]] = {}

    def _send_json(self, status: int, obj: Any) -> None:
        safe = _json_sanitize(obj)
        body = json.dumps(safe, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(
        self, status: int, text: str, content_type: str = "text/plain; charset=utf-8"
    ) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/index.html"):
            try:
                with open(os.path.join(ROOT_DIR, "index.html"), "rb") as f:
                    body = f.read()
            except FileNotFoundError:
                self._send_text(HTTPStatus.NOT_FOUND, "index.html not found")
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "jos3_version": getattr(jos3, "__version__", None)},
            )
            return

        self._send_text(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/api/simulate":
            self._send_text(HTTPStatus.NOT_FOUND, "Not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_text(HTTPStatus.BAD_REQUEST, "Bad Content-Length")
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_text(HTTPStatus.BAD_REQUEST, "Invalid JSON")
            return

        cache_key = json.dumps(
            payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
        cached = self._cache.get(cache_key)
        if cached is not None:
            status, body = cached
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return

        try:
            result = simulate_jos3(payload)
        except KeyError as e:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"missing_field: {e}"})
            return
        except ValueError as e:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"invalid_field: {e}"})
            return
        except Exception as e:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})
            return

        safe = _json_sanitize(result)
        body = json.dumps(safe, ensure_ascii=False, separators=(",", ":"))
        # Keep cache bounded.
        if len(self._cache) > 64:
            self._cache.pop(next(iter(self._cache)))
        self._cache[cache_key] = (HTTPStatus.OK, body)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
