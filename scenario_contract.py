from __future__ import annotations

import json
import math
import numbers
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator, validators
from jsonschema.exceptions import ValidationError

_ROOT = Path(__file__).resolve().parent

with (_ROOT / "scenario-contract.json").open(encoding="utf-8") as file:
    SCENARIO_CONTRACT = json.load(file)

with (_ROOT / "clothing-catalog.json").open(encoding="utf-8") as file:
    CLOTHING_CATALOG = json.load(file)

SCENARIO_DEFINITIONS = SCENARIO_CONTRACT["definitions"]
SCENARIO_SCHEMA_VERSION = int(SCENARIO_CONTRACT["properties"]["schemaVersion"]["const"])
SCENARIO_LIMITS = {
    name: SCENARIO_DEFINITIONS[name]
    for name in (
        "heightCm",
        "weightKg",
        "ageYears",
        "referenceCoreTempC",
        "durationMin",
        "airTempC",
        "windSpeedMs",
        "relativeHumidityPercent",
        "solarRadiationWm2",
        "mediumThermalConductivityWmK",
        "activityMet",
        "garmentModifier",
        "clothingClo",
    )
}
MAX_SCENARIO_DURATION_MIN = int(SCENARIO_LIMITS["durationMin"]["maximum"])
BODY_SEGMENTS = tuple(SCENARIO_DEFINITIONS["bodySegment"]["enum"])
CLOTHING_SEGMENTS = tuple(SCENARIO_DEFINITIONS["clothingSegment"]["enum"])
CLOTHING_CATEGORIES = frozenset(SCENARIO_DEFINITIONS["clothingCategory"]["enum"])
POSTURES = frozenset(SCENARIO_DEFINITIONS["posture"]["enum"])
CLOTHING_INSULATION = SCENARIO_CONTRACT["x-htmc"]["clothingInsulation"]
CLOTHING_SEGMENT_AREA_FRACTIONS = CLOTHING_INSULATION["segmentAreaFractions"]
BODY_TO_CLOTHING_SEGMENT = CLOTHING_INSULATION["bodyToClothingSegment"]
ISO_9920_INTERCEPT_CLO = float(CLOTHING_INSULATION["iso9920InterceptClo"])
ISO_9920_GARMENT_SUM_FACTOR = float(CLOTHING_INSULATION["iso9920GarmentSumFactor"])


def _is_finite_number(_checker: Any, value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, numbers.Real)
        and math.isfinite(float(value))
    )


def _is_integer(checker: Any, value: Any) -> bool:
    return _is_finite_number(checker, value) and float(value).is_integer()


_type_checker = Draft7Validator.TYPE_CHECKER.redefine_many(
    {"number": _is_finite_number, "integer": _is_integer}
)
ContractValidator = validators.extend(Draft7Validator, type_checker=_type_checker)
ContractValidator.check_schema(SCENARIO_CONTRACT)

_scenario_validator = ContractValidator(SCENARIO_CONTRACT)


def _schema_for_definition(name: str) -> dict[str, Any]:
    return {
        "$schema": SCENARIO_CONTRACT["$schema"],
        "definitions": SCENARIO_DEFINITIONS,
        "$ref": f"#/definitions/{name}",
    }


_outfit_validator = ContractValidator(
    {
        "$schema": SCENARIO_CONTRACT["$schema"],
        "definitions": SCENARIO_DEFINITIONS,
        "type": "array",
        "items": {"$ref": "#/definitions/garment"},
    }
)
_duration_validator = ContractValidator(_schema_for_definition("durationMin"))
_clothing_clo_validator = ContractValidator(_schema_for_definition("clothingClo"))
_garment_catalog_validator = ContractValidator(
    {
        "$schema": SCENARIO_CONTRACT["$schema"],
        "definitions": SCENARIO_DEFINITIONS,
        "type": "array",
        "minItems": 1,
        "items": {"$ref": "#/definitions/garmentPreset"},
    }
)


class ScenarioValidationError(ValueError):
    def __init__(self, issues: Sequence[Mapping[str, str]]) -> None:
        self.issues = tuple(dict(issue) for issue in issues)
        first = self.issues[0] if self.issues else None
        if first:
            message = f"{first['path'] or 'scenario'}: {first['message']}"
        else:
            message = "Invalid scenario"
        super().__init__(message)


def _append_path(path: str, property_name: str | int) -> str:
    if isinstance(property_name, int) or str(property_name).isdigit():
        return f"{path}[{property_name}]"
    property_text = str(property_name)
    if re.fullmatch(r"[A-Za-z_$][\w$]*", property_text):
        return f"{path}.{property_text}" if path else property_text
    return f"{path}[{json.dumps(property_text, ensure_ascii=False)}]"


def _path_from_parts(parts: Sequence[str | int]) -> str:
    path = ""
    for part in parts:
        path = _append_path(path, part)
    return path


def _quoted_properties(message: str) -> list[str]:
    return re.findall(r"'([^']+)'", message)


def _error_paths(error: ValidationError) -> list[str]:
    path = _path_from_parts(list(error.absolute_path))
    if "propertyNames" in error.absolute_schema_path:
        return [_append_path(path, str(error.instance))]
    if error.validator == "required":
        properties = _quoted_properties(error.message)
        return [_append_path(path, properties[0])] if properties else [path]
    if error.validator == "additionalProperties":
        properties = _quoted_properties(error.message)
        return [_append_path(path, prop) for prop in properties] or [path]
    if error.validator == "propertyNames":
        properties = _quoted_properties(error.message)
        return [_append_path(path, properties[0])] if properties else [path]
    return [path]


def _error_message(error: ValidationError, path: str) -> str | None:
    validator = error.validator
    if "propertyNames" in error.absolute_schema_path:
        return "Unknown clothing segment."
    if validator == "required":
        return "Is required."
    if validator == "additionalProperties":
        return "Unknown property."
    if validator == "propertyNames":
        return (
            "Unknown clothing segment."
            if ".segmentClo." in path
            else "Unknown property."
        )
    if validator == "const":
        if path == "schemaVersion":
            return f"Unsupported schema version. Expected {error.validator_value}."
        return f"Must equal {error.validator_value}."
    if validator == "type":
        expected = str(error.validator_value)
        if expected == "number":
            return "Must be a finite number."
        if expected == "integer":
            return "Must be an integer."
        article = "an" if expected == "array" else "a"
        return f"Must be {article} {expected}."
    if validator == "pattern":
        return "Must be a non-empty string."
    if validator == "enum":
        if path.endswith(".category"):
            return "Unknown clothing category."
        if path.endswith(".posture"):
            return "Must be 'standing', 'sitting', or 'lying'."
        if path == "subject.sex":
            return "Must be 'female' or 'male'."
        allowed = ", ".join(str(value) for value in error.validator_value)
        return f"Must be one of: {allowed}."
    if validator == "minimum":
        return f"Must be at least {error.validator_value}."
    if validator == "exclusiveMinimum":
        return f"Must be greater than {error.validator_value}."
    if validator == "maximum":
        return f"Must be at most {error.validator_value}."
    if validator == "minItems":
        if path == "stages":
            return "Must contain at least one stage."
        return f"Must contain at least {error.validator_value} items."
    message = error.message[:1].upper() + error.message[1:]
    return message if message.endswith(".") else f"{message}."


def _normalized_errors(errors: Sequence[ValidationError]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    ordered_errors = sorted(
        errors,
        key=lambda error: (
            _path_from_parts(list(error.absolute_path)),
            _path_from_parts(list(error.absolute_schema_path)),
        ),
    )
    for error in ordered_errors:
        for path in _error_paths(error):
            message = _error_message(error, path)
            if message is None or (path, message) in seen:
                continue
            issues.append({"path": path, "message": message})
            seen.add((path, message))
    return issues


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_valid(validator: ContractValidator, value: Any) -> bool:
    return not any(validator.iter_errors(value))


def outfit_to_icl17(outfit: Sequence[Mapping[str, Any]]) -> tuple[float, ...]:
    """Calculate regional outfit insulation in the fixed JOS-3 node order."""
    summed = {segment: 0.0 for segment in CLOTHING_SEGMENTS}
    for garment in outfit:
        modifier = float(garment["modifier"])
        for segment, clo in garment["segmentClo"].items():
            summed[segment] += float(clo) * modifier

    garment_sum = sum(
        summed[segment] * float(CLOTHING_SEGMENT_AREA_FRACTIONS[segment])
        for segment in CLOTHING_SEGMENTS
    )
    if garment_sum == 0.0:
        regional_clo = summed
    else:
        ensemble_clo = (
            ISO_9920_INTERCEPT_CLO + ISO_9920_GARMENT_SUM_FACTOR * garment_sum
        )
        scale = ensemble_clo / garment_sum
        regional_clo = {
            segment: summed[segment] * scale for segment in CLOTHING_SEGMENTS
        }
    return tuple(
        regional_clo[BODY_TO_CLOTHING_SEGMENT[body_segment]]
        for body_segment in BODY_SEGMENTS
    )


def _semantic_issues(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, Mapping):
        return []
    stages = value.get("stages")
    if not isinstance(stages, Sequence) or isinstance(stages, (str, bytes)):
        return []

    issues: list[dict[str, str]] = []
    total_duration = 0
    stage_ids: set[str] = set()
    for stage_index, stage in enumerate(stages):
        if not isinstance(stage, Mapping):
            continue
        stage_path = f"stages[{stage_index}]"
        stage_id = stage.get("id")
        if _is_non_empty_string(stage_id):
            if stage_id in stage_ids:
                issues.append(
                    {
                        "path": f"{stage_path}.id",
                        "message": "Must be unique in the scenario.",
                    }
                )
            stage_ids.add(stage_id)

        duration = stage.get("durationMin")
        if _is_valid(_duration_validator, duration):
            total_duration += int(duration)

        outfit = stage.get("outfit")
        if not _is_valid(_outfit_validator, outfit):
            continue

        instance_ids: set[str] = set()
        for garment_index, garment in enumerate(outfit):
            instance_id = garment["instanceId"]
            if instance_id in instance_ids:
                issues.append(
                    {
                        "path": (f"{stage_path}.outfit[{garment_index}].instanceId"),
                        "message": "Must be unique in the stage.",
                    }
                )
            instance_ids.add(instance_id)

        for region_index, clo in enumerate(outfit_to_icl17(outfit)):
            clo_errors = list(_clothing_clo_validator.iter_errors(clo))
            if clo_errors:
                message = _normalized_errors(clo_errors)[0]["message"]
                issues.append(
                    {
                        "path": f"{stage_path}.icl17[{region_index}]",
                        "message": message,
                    }
                )

    if total_duration > MAX_SCENARIO_DURATION_MIN:
        issues.append(
            {
                "path": "stages",
                "message": (
                    "Total duration must not exceed "
                    f"{MAX_SCENARIO_DURATION_MIN} minutes."
                ),
            }
        )
    return issues


def validate_scenario(value: Any) -> list[dict[str, str]]:
    """Validate an untrusted scenario against the shared version 1 contract."""
    issues = _normalized_errors(list(_scenario_validator.iter_errors(value)))
    issues.extend(_semantic_issues(value))
    return issues


def assert_valid_scenario(value: Any) -> None:
    issues = validate_scenario(value)
    if issues:
        raise ScenarioValidationError(issues)


def validate_garment_catalog(value: Any) -> list[dict[str, str]]:
    """Validate the shared garment preset catalog."""
    issues = _normalized_errors(list(_garment_catalog_validator.iter_errors(value)))
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return issues

    seen_ids: set[str] = set()
    for index, garment in enumerate(value):
        if not isinstance(garment, Mapping):
            continue
        garment_id = garment.get("id")
        if not _is_non_empty_string(garment_id):
            continue
        if garment_id in seen_ids:
            issues.append(
                {
                    "path": f"[{index}].id",
                    "message": "Must be unique in the catalog.",
                }
            )
        seen_ids.add(garment_id)
    return issues


_catalog_issues = validate_garment_catalog(CLOTHING_CATALOG)
if _catalog_issues:
    first_catalog_issue = _catalog_issues[0]
    raise RuntimeError(
        "Invalid clothing catalog at "
        f"{first_catalog_issue['path'] or 'catalog'}: {first_catalog_issue['message']}"
    )


__all__ = [
    "BODY_SEGMENTS",
    "BODY_TO_CLOTHING_SEGMENT",
    "CLOTHING_CATALOG",
    "CLOTHING_CATEGORIES",
    "CLOTHING_INSULATION",
    "CLOTHING_SEGMENTS",
    "CLOTHING_SEGMENT_AREA_FRACTIONS",
    "ISO_9920_GARMENT_SUM_FACTOR",
    "ISO_9920_INTERCEPT_CLO",
    "MAX_SCENARIO_DURATION_MIN",
    "POSTURES",
    "SCENARIO_CONTRACT",
    "SCENARIO_LIMITS",
    "SCENARIO_SCHEMA_VERSION",
    "ScenarioValidationError",
    "assert_valid_scenario",
    "outfit_to_icl17",
    "validate_garment_catalog",
    "validate_scenario",
]
