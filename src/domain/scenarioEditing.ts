import { createId } from "../lib/id";
import type { ScenarioStage, SimulationScenario } from "./types";

export function updateStage(
  scenario: SimulationScenario,
  stageId: string,
  update: (stage: ScenarioStage) => ScenarioStage,
): SimulationScenario {
  return {
    ...scenario,
    stages: scenario.stages.map((stage) => (stage.id === stageId ? update(stage) : stage)),
  };
}

export function duplicateStage(
  scenario: SimulationScenario,
  stageId: string,
  copiedName: string,
): { scenario: SimulationScenario; stageId: string } {
  const sourceIndex = scenario.stages.findIndex((stage) => stage.id === stageId);
  if (sourceIndex < 0) {
    return { scenario, stageId };
  }

  const duplicate = structuredClone(scenario.stages[sourceIndex]);
  duplicate.id = createId("stage");
  duplicate.name = copiedName;
  duplicate.outfit = duplicate.outfit.map((garment) => ({
    ...garment,
    instanceId: createId("garment"),
  }));

  const stages = [...scenario.stages];
  stages.splice(sourceIndex + 1, 0, duplicate);
  return { scenario: { ...scenario, stages }, stageId: duplicate.id };
}

export function removeStage(
  scenario: SimulationScenario,
  stageId: string,
): { scenario: SimulationScenario; stageId: string } {
  if (scenario.stages.length <= 1) {
    return { scenario, stageId };
  }
  const sourceIndex = scenario.stages.findIndex((stage) => stage.id === stageId);
  if (sourceIndex < 0) {
    return { scenario, stageId };
  }

  const stages = scenario.stages.filter((stage) => stage.id !== stageId);
  const nextIndex = Math.min(sourceIndex, stages.length - 1);
  return {
    scenario: { ...scenario, stages },
    stageId: stages[nextIndex].id,
  };
}

export function moveStage(
  scenario: SimulationScenario,
  stageId: string,
  offset: -1 | 1,
): SimulationScenario {
  const sourceIndex = scenario.stages.findIndex((stage) => stage.id === stageId);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= scenario.stages.length) {
    return scenario;
  }

  const stages = [...scenario.stages];
  [stages[sourceIndex], stages[targetIndex]] = [stages[targetIndex], stages[sourceIndex]];
  return { ...scenario, stages };
}
