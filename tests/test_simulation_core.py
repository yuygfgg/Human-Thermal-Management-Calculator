import json
import unittest

from simulation_core import simulate_jos3


def make_payload(duration_min=30):
    return {
        "sex": "female",
        "height_cm": 165,
        "weight_kg": 50,
        "age_years": 17,
        "base_core_temp_c": 36.6,
        "air_temp_c": 5,
        "wind_speed_ms": 15 / 3.6,
        "rh_percent": 50,
        "medium_thermal_conductivity_w_mk": 0.026,
        "solar_radiation_wm2": 400,
        "activity_met": 2.6,
        "duration_min": duration_min,
        "posture": "standing",
        "icl17": [0.0] * 17,
    }


class SimulationCoreTests(unittest.TestCase):
    def test_zero_duration_returns_initial_history_row(self):
        result = simulate_jos3(make_payload(0))
        self.assertEqual(result["dataHistory"]["time"], [0.0])
        self.assertEqual(len(result["dataHistory"]["coreTemp"]), 1)
        json.dumps(result, allow_nan=False)

    def test_result_schema_and_history_lengths(self):
        result = simulate_jos3(make_payload(3))
        history = result["dataHistory"]
        self.assertEqual(len(history["time"]), 4)
        self.assertEqual(len(history["comfortScore"]), 4)
        self.assertEqual(result["jos3"]["version"], "0.5.0")
        self.assertIn("Tcb", result["jos3"]["results"])
        json.dumps(result, allow_nan=False)

    def test_duration_is_bounded(self):
        result = simulate_jos3(make_payload(10_000))
        self.assertEqual(len(result["dataHistory"]["time"]), 24 * 60 + 1)


if __name__ == "__main__":
    unittest.main()
