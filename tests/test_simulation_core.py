import copy
import json
import unittest
from unittest.mock import patch

import simulation_core
from simulation_core import (
    MAX_SCENARIO_DURATION_MIN,
    simulate_jos3,
    simulate_scenario,
)


def make_legacy_payload(duration_min=4):
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


def make_stage(stage_id="stage-1", duration_min=4, **overrides):
    stage = {
        "id": stage_id,
        "name": f"Stage {stage_id}",
        "duration_min": duration_min,
        "environment": {
            "air_temp_c": 5,
            "wind_speed_ms": 15 / 3.6,
            "rh_percent": 50,
            "medium_thermal_conductivity_w_mk": 0.026,
            "solar_radiation_wm2": 400,
        },
        "activity_met": 2.6,
        "posture": "standing",
        "icl17": [0.0] * 17,
    }
    stage.update(overrides)
    return stage


def make_scenario(stages=None):
    return {
        "schemaVersion": 1,
        "subject": {
            "sex": "female",
            "height_cm": 165,
            "weight_kg": 50,
            "age_years": 17,
            "base_core_temp_c": 36.6,
        },
        "stages": stages if stages is not None else [make_stage()],
    }


class LegacySimulationTests(unittest.TestCase):
    def test_zero_duration_returns_initial_history_row(self):
        result = simulate_jos3(make_legacy_payload(0))

        self.assertEqual(result["dataHistory"]["time"], [0.0])
        self.assertEqual(len(result["dataHistory"]["coreTemp"]), 1)
        self.assertIsNone(result["stageRanges"][0]["resultStartIndex"])
        json.dumps(result, allow_nan=False)

    def test_legacy_payload_matches_an_equivalent_single_stage(self):
        legacy_result = simulate_jos3(make_legacy_payload(3))
        scenario_result = simulate_scenario(make_scenario([make_stage(duration_min=3)]))

        for key in (
            "coreTemp",
            "skinTemp",
            "netRate",
            "shiveringIntensity",
            "sweatingIntensity",
        ):
            self.assertEqual(
                legacy_result["dataHistory"][key],
                scenario_result["dataHistory"][key],
            )
        self.assertEqual(
            legacy_result["regionalMetrics"],
            scenario_result["regionalMetrics"],
        )

    def test_legacy_duration_is_clamped_to_24_hours(self):
        result = simulate_jos3(make_legacy_payload(10_000))

        self.assertEqual(
            len(result["dataHistory"]["time"]),
            MAX_SCENARIO_DURATION_MIN + 1,
        )


class ScenarioSimulationTests(unittest.TestCase):
    def test_result_contains_aligned_global_and_regional_histories(self):
        result = simulate_scenario(make_scenario([make_stage(duration_min=3)]))
        history = result["dataHistory"]
        regional = result["regionalMetrics"]

        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["jos3"]["version"], "0.5.0")
        self.assertIn("Tcb", result["jos3"]["results"])
        self.assertEqual(len(history["time"]), 4)
        self.assertEqual(len(history["comfortScore"]), 4)
        self.assertEqual(len(regional["regionIds"]), 17)
        for metric in (
            "Tsk",
            "Tcr",
            "Wet",
            "BFsk",
            "Mshiv",
            "Esweat",
            "THLsk",
            "Icl",
        ):
            self.assertEqual(len(regional[metric]), len(history["time"]))
            self.assertTrue(all(len(row) == 17 for row in regional[metric]))
        json.dumps(result, allow_nan=False)

    def test_identical_adjacent_stages_equal_one_merged_stage(self):
        split = make_scenario(
            [
                make_stage("first", duration_min=2),
                make_stage("second", duration_min=3),
            ]
        )
        merged = make_scenario([make_stage("merged", duration_min=5)])

        split_result = simulate_scenario(split)
        merged_result = simulate_scenario(merged)

        for key in (
            "coreTemp",
            "skinTemp",
            "netRate",
            "shiveringIntensity",
            "shiveringFatigueScale",
        ):
            self.assertEqual(
                split_result["dataHistory"][key],
                merged_result["dataHistory"][key],
            )
        for metric in ("Tsk", "Tcr", "BFsk", "Mshiv"):
            self.assertEqual(
                split_result["regionalMetrics"][metric],
                merged_result["regionalMetrics"][metric],
            )

    def test_stage_transition_uses_one_model_and_preserves_boundary_state(self):
        warm_environment = {
            "air_temp_c": 30,
            "wind_speed_ms": 0.1,
            "rh_percent": 60,
            "solar_radiation_wm2": 0,
            "medium_thermal_conductivity_w_mk": 0.026,
        }
        second = make_stage(
            "warm",
            duration_min=2,
            environment=warm_environment,
            activity_met=1.1,
            posture="sitting",
            icl17=[0.8] * 17,
        )
        original_constructor = simulation_core.jos3.JOS3
        with patch.object(
            simulation_core.jos3,
            "JOS3",
            side_effect=original_constructor,
        ) as constructor:
            result = simulate_scenario(
                make_scenario([make_stage("cold", duration_min=2), second])
            )

        self.assertEqual(constructor.call_count, 1)
        self.assertEqual(result["dataHistory"]["time"], [0, 1, 2, 3, 4])
        self.assertEqual(result["stageRanges"][0]["resultEndIndex"], 2)
        self.assertEqual(result["stageRanges"][1]["resultStartIndex"], 3)
        self.assertEqual(
            result["dataHistory"]["stageId"],
            ["cold", "cold", "cold", "warm", "warm"],
        )
        self.assertEqual(result["regionalMetrics"]["Icl"][2], [0.0] * 17)
        self.assertEqual(result["regionalMetrics"]["Icl"][3], [0.8] * 17)
        self.assertNotEqual(
            result["regionalMetrics"]["Tsk"][2],
            result["regionalMetrics"]["Tsk"][0],
        )

    def test_profiles_reach_both_endpoints_and_update_each_minute(self):
        stage = make_stage(
            duration_min=3,
            environment={
                "air_temp_c": {"start": 5, "end": 11},
                "wind_speed_ms": {"start": 0.2, "end": 0.8},
                "rh_percent": {"start": 40, "end": 70},
                "solar_radiation_wm2": {"start": 0, "end": 300},
                "medium_thermal_conductivity_w_mk": {
                    "start": 0.026,
                    "end": 0.052,
                },
            },
            activity_met={"start": 1.0, "end": 2.0},
        )

        history = simulate_scenario(make_scenario([stage]))["dataHistory"]

        self.assertEqual(history["airTemp"], [5.0, 5.0, 8.0, 11.0])
        self.assertEqual(history["relativeHumidity"], [40.0, 40.0, 55.0, 70.0])
        self.assertEqual(history["solarRadiation"], [0.0, 0.0, 150.0, 300.0])
        self.assertEqual(history["activityMet"], [1.0, 1.0, 1.5, 2.0])
        self.assertAlmostEqual(history["mediumHcScale"][0], 1.0)
        self.assertAlmostEqual(history["mediumHcScale"][-1], 2.0)
        self.assertGreater(
            history["shiveringActivityScale"][0],
            history["shiveringActivityScale"][-1],
        )

    def test_stage_ranges_and_summaries_exclude_shared_boundary_rows(self):
        result = simulate_scenario(
            make_scenario(
                [
                    make_stage("one", duration_min=2),
                    make_stage("two", duration_min=3),
                ]
            )
        )

        self.assertEqual(
            result["stageRanges"],
            [
                {
                    "id": "one",
                    "name": "Stage one",
                    "stageIndex": 0,
                    "startMinute": 0,
                    "endMinute": 2,
                    "durationMin": 2,
                    "resultStartIndex": 1,
                    "resultEndIndex": 2,
                    "initialStateIndex": 0,
                },
                {
                    "id": "two",
                    "name": "Stage two",
                    "stageIndex": 1,
                    "startMinute": 2,
                    "endMinute": 5,
                    "durationMin": 3,
                    "resultStartIndex": 3,
                    "resultEndIndex": 5,
                    "initialStateIndex": None,
                },
            ],
        )
        self.assertEqual(
            [item["sampleCount"] for item in result["stageSummaries"]],
            [2, 3],
        )
        self.assertEqual(result["stageSummaries"][0]["final"]["timeMin"], 2.0)
        self.assertEqual(result["stageSummaries"][1]["final"]["timeMin"], 5.0)


class ScenarioValidationTests(unittest.TestCase):
    def assert_invalid(self, scenario, message):
        with self.assertRaisesRegex(ValueError, message):
            simulate_scenario(scenario)

    def test_total_duration_must_not_exceed_24_hours(self):
        scenario = make_scenario(
            [
                make_stage("first", duration_min=720),
                make_stage("second", duration_min=721),
            ]
        )

        self.assert_invalid(scenario, "must not exceed 1440 minutes")

    def test_schema_rejects_invalid_structure_and_values(self):
        cases = []

        missing_version = make_scenario()
        del missing_version["schemaVersion"]
        cases.append((missing_version, "schemaVersion must be an integer"))

        no_stages = make_scenario([])
        cases.append((no_stages, "stages must contain at least one stage"))

        duplicate_ids = make_scenario([make_stage("same"), make_stage("same")])
        cases.append((duplicate_ids, "id must be unique"))

        incomplete_profile = make_scenario()
        incomplete_profile["stages"][0]["environment"]["air_temp_c"] = {"start": 5}
        cases.append((incomplete_profile, "profile must contain start and end"))

        bad_icl = make_scenario()
        bad_icl["stages"][0]["icl17"] = [0.0] * 16
        cases.append((bad_icl, "icl17 must be a 17-length array"))

        bad_posture = make_scenario()
        bad_posture["stages"][0]["posture"] = "crouching"
        cases.append((bad_posture, "posture must be"))

        non_integer_duration = make_scenario()
        non_integer_duration["stages"][0]["duration_min"] = 3.5
        cases.append((non_integer_duration, "duration_min must be an integer"))

        non_finite_number = make_scenario()
        non_finite_number["stages"][0]["activity_met"] = float("nan")
        cases.append((non_finite_number, "activity_met.start must be a finite number"))

        for scenario, message in cases:
            with self.subTest(message=message):
                self.assert_invalid(copy.deepcopy(scenario), message)


if __name__ == "__main__":
    unittest.main()
