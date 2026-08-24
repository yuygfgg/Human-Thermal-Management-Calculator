import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import simulation_core
import scenario_contract
from simulation_core import MAX_SCENARIO_DURATION_MIN, simulate_scenario


def profile(value):
    return {"start": value, "end": value}


def make_garment(
    garment_id="garment-1",
    instance_id="garment-instance-1",
    segment_clo=None,
    modifier=1.0,
):
    return {
        "id": garment_id,
        "instanceId": instance_id,
        "nameZh": "Garment",
        "nameEn": "Garment",
        "category": "base",
        "modifier": modifier,
        "segmentClo": segment_clo or {},
    }


def make_uniform_outfit(clo):
    return [
        make_garment(
            segment_clo={
                segment: clo for segment in scenario_contract.CLOTHING_SEGMENTS
            }
        )
    ]


def make_stage(stage_id="stage-1", duration_min=4, **overrides):
    stage = {
        "id": stage_id,
        "name": f"Stage {stage_id}",
        "durationMin": duration_min,
        "environment": {
            "airTempC": profile(5),
            "windSpeedMs": profile(15 / 3.6),
            "relativeHumidityPercent": profile(50),
            "mediumThermalConductivityWmK": profile(0.026),
            "solarRadiationWm2": profile(400),
        },
        "activityMet": profile(2.6),
        "posture": "standing",
        "outfit": [],
    }
    stage.update(overrides)
    return stage


def make_scenario(stages=None):
    return {
        "schemaVersion": 1,
        "name": "Test scenario",
        "subject": {
            "sex": "female",
            "heightCm": 165,
            "weightKg": 50,
            "ageYears": 17,
            "referenceCoreTempC": 36.6,
        },
        "stages": stages if stages is not None else [make_stage()],
    }


class ScenarioSimulationTests(unittest.TestCase):
    def test_exported_scenario_json_is_the_simulation_input(self):
        fixture_path = Path(__file__).parent / "fixtures" / "exported-scenario-v1.json"
        with fixture_path.open(encoding="utf-8") as file:
            scenario = json.load(file)

        result = simulate_scenario(scenario)

        self.assertEqual(result["scenario"], scenario)
        self.assertEqual(result["dataHistory"]["time"], [0.0, 1.0])

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
            "airTempC": profile(30),
            "windSpeedMs": profile(0.1),
            "relativeHumidityPercent": profile(60),
            "solarRadiationWm2": profile(0),
            "mediumThermalConductivityWmK": profile(0.026),
        }
        second = make_stage(
            "warm",
            duration_min=2,
            environment=warm_environment,
            activityMet=profile(1.1),
            posture="sitting",
            outfit=make_uniform_outfit(0.8),
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

        expected_clo = 0.161 + (0.835 * 0.8)
        self.assertEqual(constructor.call_count, 1)
        self.assertEqual(result["dataHistory"]["time"], [0, 1, 2, 3, 4])
        self.assertEqual(result["stageRanges"][0]["resultEndIndex"], 2)
        self.assertEqual(result["stageRanges"][1]["resultStartIndex"], 3)
        self.assertEqual(
            result["dataHistory"]["stageId"],
            ["cold", "cold", "cold", "warm", "warm"],
        )
        self.assertEqual(result["regionalMetrics"]["Icl"][2], [0.0] * 17)
        for value in result["regionalMetrics"]["Icl"][3]:
            self.assertAlmostEqual(value, expected_clo)
        self.assertNotEqual(
            result["regionalMetrics"]["Tsk"][2],
            result["regionalMetrics"]["Tsk"][0],
        )

    def test_profiles_reach_both_endpoints_and_update_each_minute(self):
        stage = make_stage(
            duration_min=3,
            environment={
                "airTempC": {"start": 5, "end": 11},
                "windSpeedMs": {"start": 0.2, "end": 0.8},
                "relativeHumidityPercent": {"start": 40, "end": 70},
                "solarRadiationWm2": {"start": 0, "end": 300},
                "mediumThermalConductivityWmK": {
                    "start": 0.026,
                    "end": 0.052,
                },
            },
            activityMet={"start": 1.0, "end": 2.0},
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
    def assert_invalid(self, scenario, path, message):
        self.assertIn(
            {"path": path, "message": message},
            scenario_contract.validate_scenario(scenario),
        )
        with self.assertRaises(scenario_contract.ScenarioValidationError):
            simulate_scenario(scenario)

    def test_total_duration_must_not_exceed_24_hours(self):
        scenario = make_scenario(
            [
                make_stage("first", duration_min=720),
                make_stage("second", duration_min=721),
            ]
        )

        self.assert_invalid(
            scenario,
            "stages",
            "Total duration must not exceed 1440 minutes.",
        )

    def test_exact_duration_boundary_is_accepted(self):
        scenario = make_scenario([make_stage(duration_min=MAX_SCENARIO_DURATION_MIN)])

        result = simulate_scenario(scenario)

        self.assertEqual(
            len(result["dataHistory"]["time"]), MAX_SCENARIO_DURATION_MIN + 1
        )

    def test_schema_rejects_invalid_structure_and_values(self):
        cases = []

        missing_version = make_scenario()
        del missing_version["schemaVersion"]
        cases.append((missing_version, "schemaVersion", "Is required."))

        no_stages = make_scenario([])
        cases.append((no_stages, "stages", "Must contain at least one stage."))

        duplicate_ids = make_scenario([make_stage("same"), make_stage("same")])
        cases.append(
            (
                duplicate_ids,
                "stages[1].id",
                "Must be unique in the scenario.",
            )
        )

        incomplete_profile = make_scenario()
        incomplete_profile["stages"][0]["environment"]["airTempC"] = {"start": 5}
        cases.append(
            (
                incomplete_profile,
                "stages[0].environment.airTempC.end",
                "Is required.",
            )
        )

        invalid_outfit = make_scenario()
        invalid_outfit["stages"][0]["outfit"] = [
            make_garment(segment_clo={"Unknown": 0.5})
        ]
        cases.append(
            (
                invalid_outfit,
                "stages[0].outfit[0].segmentClo.Unknown",
                "Unknown clothing segment.",
            )
        )

        bad_posture = make_scenario()
        bad_posture["stages"][0]["posture"] = "crouching"
        cases.append(
            (
                bad_posture,
                "stages[0].posture",
                "Must be 'standing', 'sitting', or 'lying'.",
            )
        )

        non_integer_duration = make_scenario()
        non_integer_duration["stages"][0]["durationMin"] = 3.5
        cases.append(
            (
                non_integer_duration,
                "stages[0].durationMin",
                "Must be an integer.",
            )
        )

        non_finite_number = make_scenario()
        non_finite_number["stages"][0]["activityMet"]["start"] = float("nan")
        cases.append(
            (
                non_finite_number,
                "stages[0].activityMet.start",
                "Must be a finite number.",
            )
        )

        out_of_range_subject = make_scenario()
        out_of_range_subject["subject"]["heightCm"] = 99
        cases.append(
            (
                out_of_range_subject,
                "subject.heightCm",
                "Must be at least 100.",
            )
        )

        for scenario, path, message in cases:
            with self.subTest(path=path):
                self.assert_invalid(copy.deepcopy(scenario), path, message)

    def test_removed_snake_case_protocol_is_rejected(self):
        old_protocol = make_scenario()
        old_protocol["subject"] = {
            "sex": "female",
            "height_cm": 165,
            "weight_kg": 50,
            "age_years": 17,
            "base_core_temp_c": 36.6,
        }

        issues = scenario_contract.validate_scenario(old_protocol)

        self.assertIn(
            {"path": "subject.heightCm", "message": "Is required."},
            issues,
        )
        self.assertIn(
            {"path": "subject.height_cm", "message": "Unknown property."},
            issues,
        )


class ClothingCatalogTests(unittest.TestCase):
    def test_shared_catalog_is_valid_and_has_unique_ids(self):
        self.assertEqual(
            scenario_contract.validate_garment_catalog(
                scenario_contract.CLOTHING_CATALOG
            ),
            [],
        )
        ids = [garment["id"] for garment in scenario_contract.CLOTHING_CATALOG]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
