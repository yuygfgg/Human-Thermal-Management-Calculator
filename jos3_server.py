from __future__ import annotations

import argparse
import json
import math
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Tuple

import numpy as np

import jos3


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

# Tikuisis et al. cold-water exercise studies suggest full shivering suppression
# around extra metabolic heat production ~250–300 W. Default: 270 W.
DEFAULT_SHIVER_SUPPRESS_THRESHOLD_W = 270.0


def _patch_jos3_shivering() -> None:
    # Patch only once per process.
    try:
        import jos3.thermoregulation as threg  # type: ignore
    except Exception:
        return
    if getattr(threg, "_htm_shivering_patched", False):
        return

    orig = threg.shivering

    def shivering_with_activity(*args: Any, **kwargs: Any) -> Any:
        mshiv = orig(*args, **kwargs)
        options = kwargs.get("options", None)
        if options is None and args and isinstance(args[-1], dict):
            options = args[-1]
        scale = 1.0
        try:
            if isinstance(options, dict):
                scale = float(options.get("shivering_activity_scale", 1.0))
        except Exception:
            scale = 1.0

        if scale >= 0.999:
            return mshiv

        if scale <= 1e-6:
            try:
                threg.PRE_SHIV = 0
            except Exception:
                pass
            return np.zeros_like(mshiv)

        try:
            threg.PRE_SHIV = float(getattr(threg, "PRE_SHIV", 0.0)) * scale
        except Exception:
            pass
        return np.asarray(mshiv, dtype=float) * scale

    threg.shivering = shivering_with_activity  # type: ignore[assignment]
    threg._htm_shivering_patched = True  # type: ignore[attr-defined]


_patch_jos3_shivering()


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _json_sanitize(obj: Any) -> Any:
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if isinstance(obj, dict):
        return {k: _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_sanitize(v) for v in obj]
    if isinstance(obj, tuple):
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


def _regional_clo_to_icl17(regional_clo: Dict[str, float]) -> np.ndarray:
    # 17 segments in JOS-3: Head, Neck, Chest, Back, Pelvis,
    # LShoulder, LArm, LHand, RShoulder, RArm, RHand,
    # LThigh, LLeg, LFoot, RThigh, RLeg, RFoot
    h = float(regional_clo.get("head", 0.0) or 0.0)
    t = float(regional_clo.get("torso", 0.0) or 0.0)
    a = float(regional_clo.get("arms", 0.0) or 0.0)
    ha = float(regional_clo.get("hands", 0.0) or 0.0)
    l = float(regional_clo.get("legs", 0.0) or 0.0)
    f = float(regional_clo.get("feet", 0.0) or 0.0)

    return np.array(
        [
            h,  # Head
            h,  # Neck
            t,  # Chest
            t,  # Back
            t,  # Pelvis
            a,  # LShoulder
            a,  # LArm
            ha,  # LHand
            a,  # RShoulder
            a,  # RArm
            ha,  # RHand
            l,  # LThigh
            l,  # LLeg
            f,  # LFoot
            l,  # RThigh
            l,  # RLeg
            f,  # RFoot
        ],
        dtype=float,
    )


def _sum_segments(d: Dict[str, List[float]], prefix: str) -> List[float]:
    keys = [k for k in d.keys() if k.startswith(prefix)]
    keys.sort()
    if not keys:
        return [0.0 for _ in range(len(d.get("ModTime", [])))]
    arr = np.zeros(len(d[keys[0]]), dtype=float)
    for k in keys:
        arr += np.asarray(d[k], dtype=float)
    return arr.tolist()


def _sanitize_jos3_results(d: Dict[str, Any]) -> Dict[str, List[float]]:
    out: Dict[str, List[float]] = {}
    for k, series in d.items():
        # dict_results returns list-like for all keys we care about.
        if not isinstance(series, (list, tuple, np.ndarray)):
            continue
        vals: List[float] = []
        ok = True
        for v in series:
            if hasattr(v, "total_seconds"):
                vals.append(float(v.total_seconds()))
            else:
                try:
                    vals.append(float(v))
                except Exception:
                    ok = False
                    break
        if ok:
            out[str(k)] = vals
    return out


def simulate_jos3(payload: Dict[str, Any]) -> Dict[str, Any]:
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

    regional_clo = payload.get("regional_clo") or {}
    if not isinstance(regional_clo, dict):
        regional_clo = {}

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

    model.Icl = _regional_clo_to_icl17(regional_clo)

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
    duration_min = max(0, min(duration_min, 24 * 60))
    model.simulate(times=duration_min, dtime=60)
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
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
