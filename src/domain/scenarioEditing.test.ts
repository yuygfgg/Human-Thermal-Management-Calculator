import { describe, expect, it } from "vitest";

import { createSingleStageScenario } from "../data/templates";
import { duplicateStage, moveStage, removeStage } from "./scenarioEditing";

describe("scenario editing", () => {
  it("duplicates a stage with independent identifiers", () => {
    const source = createSingleStageScenario();
    const result = duplicateStage(source, source.stages[0].id, "Copy");
    expect(result.scenario.stages).toHaveLength(2);
    expect(result.scenario.stages[1].id).not.toBe(source.stages[0].id);
    expect(result.scenario.stages[1].outfit[0].instanceId).not.toBe(
      source.stages[0].outfit[0].instanceId,
    );
  });

  it("never removes the final stage", () => {
    const source = createSingleStageScenario();
    expect(removeStage(source, source.stages[0].id).scenario).toBe(source);
  });

  it("moves a stage without changing its data", () => {
    const source = createSingleStageScenario();
    const duplicated = duplicateStage(source, source.stages[0].id, "Copy").scenario;
    const moved = moveStage(duplicated, duplicated.stages[1].id, -1);
    expect(moved.stages[0].name).toBe("Copy");
  });
});
