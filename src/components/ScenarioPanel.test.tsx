import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createSingleStageScenario } from "../data/templates";
import type { Language, SimulationScenario } from "../domain/types";
import { ScenarioPanel } from "./ScenarioPanel";

afterEach(cleanup);

function ScenarioHarness({
  initialScenario,
  language,
  onScenarioChange,
}: {
  initialScenario: SimulationScenario;
  language: Language;
  onScenarioChange?: (scenario: SimulationScenario) => void;
}) {
  const [scenario, setScenario] = useState(initialScenario);
  const [selectedStageId, setSelectedStageId] = useState(initialScenario.stages[0].id);

  return (
    <ScenarioPanel
      scenario={scenario}
      selectedStageId={selectedStageId}
      issues={[]}
      language={language}
      onChange={(nextScenario) => {
        setScenario(nextScenario);
        onScenarioChange?.(nextScenario);
      }}
      onSelectStage={setSelectedStageId}
    />
  );
}

describe("ScenarioPanel regional clothing editor", () => {
  it("expands one garment and updates its regional clo without mutating the source", async () => {
    const user = userEvent.setup();
    const initialScenario = createSingleStageScenario();
    let latestScenario = initialScenario;

    render(
      <ScenarioHarness
        initialScenario={initialScenario}
        language="zh"
        onScenarioChange={(scenario) => { latestScenario = scenario; }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "编辑分区 clo: 棉质 T 恤" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const regionalEditor = screen.getByRole("group", { name: "分区 clo: 棉质 T 恤" });
    expect(regionalEditor).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("收起分区 clo: 棉质 T 恤");
    expect(toggle).toHaveAttribute("aria-controls", regionalEditor.id);
    expect(regionalEditor).toHaveAccessibleDescription("基础 clo；0 表示未覆盖。");

    const chestInput = within(regionalEditor).getByRole("spinbutton", { name: "胸部 clo" });
    expect(chestInput).toHaveValue(0.1);
    fireEvent.change(chestInput, { target: { value: "0.42" } });

    expect(latestScenario.stages[0].outfit[0].segmentClo.Chest).toBe(0.42);
    expect(initialScenario.stages[0].outfit[0].segmentClo.Chest).toBe(0.1);
  });

  it("removes an uncovered region and exposes English accessible names", async () => {
    const user = userEvent.setup();
    const initialScenario = createSingleStageScenario();
    let latestScenario = initialScenario;

    render(
      <ScenarioHarness
        initialScenario={initialScenario}
        language="en"
        onScenarioChange={(scenario) => { latestScenario = scenario; }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit regional clo: Cotton T-shirt" }));
    const regionalEditor = screen.getByRole("group", { name: "Regional clo: Cotton T-shirt" });
    expect(regionalEditor).toBeVisible();

    const armInput = within(regionalEditor).getByRole("spinbutton", { name: "Arm clo" });
    expect(armInput).toHaveValue(0.02);
    fireEvent.change(armInput, { target: { value: "" } });

    expect(latestScenario.stages[0].outfit[0].segmentClo.Arm).toBeUndefined();
  });

  it("keeps invalid negative drafts in the scenario for validation", async () => {
    const user = userEvent.setup();
    const initialScenario = createSingleStageScenario();
    let latestScenario = initialScenario;

    render(
      <ScenarioHarness
        initialScenario={initialScenario}
        language="en"
        onScenarioChange={(scenario) => { latestScenario = scenario; }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit regional clo: Cotton T-shirt" }));
    const regionalEditor = screen.getByRole("group", { name: "Regional clo: Cotton T-shirt" });
    const chestInput = within(regionalEditor).getByRole("spinbutton", { name: "Chest clo" });
    fireEvent.change(chestInput, { target: { value: "-0.2" } });

    expect(chestInput).toHaveValue(-0.2);
    expect(latestScenario.stages[0].outfit[0].segmentClo.Chest).toBe(-0.2);
  });

  it("synchronizes open fields when the scenario is replaced under stable ids", async () => {
    const user = userEvent.setup();
    const initialScenario = createSingleStageScenario();
    const selectedStageId = initialScenario.stages[0].id;
    const replacementScenario: SimulationScenario = {
      ...initialScenario,
      stages: [{
        ...initialScenario.stages[0],
        outfit: initialScenario.stages[0].outfit.map((garment, index) => (
          index === 0
            ? { ...garment, segmentClo: { ...garment.segmentClo, Chest: 0.77 } }
            : garment
        )),
      }],
    };
    const panel = (scenario: SimulationScenario) => (
      <ScenarioPanel
        scenario={scenario}
        selectedStageId={selectedStageId}
        issues={[]}
        language="en"
        onChange={() => undefined}
        onSelectStage={() => undefined}
      />
    );
    const { rerender } = render(panel(initialScenario));

    await user.click(screen.getByRole("button", { name: "Edit regional clo: Cotton T-shirt" }));
    const chestInput = within(
      screen.getByRole("group", { name: "Regional clo: Cotton T-shirt" }),
    ).getByRole("spinbutton", { name: "Chest clo" });
    expect(chestInput).toHaveValue(0.1);

    rerender(panel(replacementScenario));
    expect(chestInput).toHaveValue(0.77);
  });
});

describe("ScenarioPanel stage controls", () => {
  it("keeps incomplete numeric drafts out of scalar profiles", () => {
    const initialScenario = createSingleStageScenario();
    const initialTemperature = initialScenario.stages[0].environment.airTempC.start;
    let latestScenario = initialScenario;

    render(
      <ScenarioHarness
        initialScenario={initialScenario}
        language="zh"
        onScenarioChange={(scenario) => { latestScenario = scenario; }}
      />,
    );

    const temperatureInput = screen.getByRole("spinbutton", { name: "空气温度 °C" });
    const profileField = temperatureInput.closest(".profile-field");
    if (!(profileField instanceof HTMLElement)) {
      throw new Error("Air temperature profile field was not rendered.");
    }
    const variesToggle = within(profileField).getByRole("checkbox", { name: "阶段内变化" });

    fireEvent.change(temperatureInput, { target: { value: "-" } });

    expect(latestScenario.stages[0].environment.airTempC).toEqual({
      start: initialTemperature,
      end: initialTemperature,
    });
    expect(variesToggle).not.toBeChecked();

    fireEvent.blur(temperatureInput);
    expect(temperatureInput).toHaveValue(initialTemperature);

    fireEvent.change(temperatureInput, { target: { value: "-5" } });
    expect(latestScenario.stages[0].environment.airTempC).toEqual({ start: -5, end: -5 });
    expect(variesToggle).not.toBeChecked();

    fireEvent.change(temperatureInput, { target: { value: "" } });
    fireEvent.blur(temperatureInput);
    expect(temperatureInput).toHaveValue(-5);
  });

  it("synchronizes numeric drafts when the scenario is replaced", () => {
    const initialScenario = createSingleStageScenario();
    const replacementScenario: SimulationScenario = {
      ...initialScenario,
      stages: [{
        ...initialScenario.stages[0],
        environment: {
          ...initialScenario.stages[0].environment,
          airTempC: { start: 8, end: 8 },
        },
      }],
    };
    const panel = (scenario: SimulationScenario) => (
      <ScenarioPanel
        scenario={scenario}
        selectedStageId={scenario.stages[0].id}
        issues={[]}
        language="zh"
        onChange={() => undefined}
        onSelectStage={() => undefined}
      />
    );
    const { rerender } = render(panel(initialScenario));
    const temperatureInput = screen.getByRole("spinbutton", { name: "空气温度 °C" });

    fireEvent.change(temperatureInput, { target: { value: "" } });
    expect(temperatureInput).toHaveValue(null);

    rerender(panel(replacementScenario));
    expect(temperatureInput).toHaveValue(8);
  });

  it("places posture before the activity preset in reading and focus order", () => {
    render(
      <ScenarioHarness
        initialScenario={createSingleStageScenario()}
        language="zh"
      />,
    );

    const activitySection = screen.getByRole("region", { name: "活动与姿势" });
    const controls = within(activitySection).getAllByRole("combobox");

    expect(controls).toHaveLength(2);
    expect(controls[0]).toHaveAccessibleName("姿势");
    expect(controls[1]).toHaveAccessibleName("活动预设");
  });

  it("offers solar presets while keeping the numeric profile editable", async () => {
    const user = userEvent.setup();
    const initialScenario = createSingleStageScenario();
    let latestScenario = initialScenario;

    render(
      <ScenarioHarness
        initialScenario={initialScenario}
        language="zh"
        onScenarioChange={(scenario) => { latestScenario = scenario; }}
      />,
    );

    const solarGroup = screen.getByRole("group", { name: "太阳辐射" });
    const presetSelect = within(solarGroup).getByRole("combobox", { name: "日照条件" });

    expect(presetSelect).toHaveValue("shade");
    expect(within(presetSelect).getAllByRole("option")).toHaveLength(6);
    expect(within(presetSelect).getByRole("option", { name: "晴天 · 600 W/m²" })).toBeVisible();
    expect(within(presetSelect).getByRole("option", { name: "自定义数值" })).toBeEnabled();
    expect(within(solarGroup).queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.selectOptions(presetSelect, "sunny");
    expect(latestScenario.stages[0].environment.solarRadiationWm2).toEqual({
      start: 600,
      end: 600,
    });
    expect(within(solarGroup).queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.selectOptions(presetSelect, "custom");
    const solarInput = within(solarGroup).getByRole("spinbutton", { name: "太阳辐射 W/m²" });
    expect(solarInput).toHaveValue(600);
    fireEvent.change(solarInput, { target: { value: "350" } });

    expect(presetSelect).toHaveValue("custom");
    expect(latestScenario.stages[0].environment.solarRadiationWm2).toEqual({
      start: 350,
      end: 350,
    });

    await user.click(within(solarGroup).getByRole("checkbox", { name: "阶段内变化" }));
    expect(latestScenario.stages[0].environment.solarRadiationWm2).toEqual({
      start: 350,
      end: 400,
    });

    await user.selectOptions(presetSelect, "overcast");
    expect(latestScenario.stages[0].environment.solarRadiationWm2).toEqual({
      start: 200,
      end: 200,
    });
    expect(within(solarGroup).queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.selectOptions(presetSelect, "custom");
    const exactPresetInput = within(solarGroup).getByRole("spinbutton", { name: "太阳辐射 W/m²" });
    fireEvent.change(exactPresetInput, { target: { value: "400" } });

    expect(presetSelect).toHaveValue("custom");
    expect(exactPresetInput).toHaveValue(400);
    expect(latestScenario.stages[0].environment.solarRadiationWm2).toEqual({
      start: 400,
      end: 400,
    });
  });

  it("synchronizes the solar mode when an external scenario replaces the profile", () => {
    const initialScenario = createSingleStageScenario();
    const customScenario: SimulationScenario = {
      ...initialScenario,
      stages: [{
        ...initialScenario.stages[0],
        environment: {
          ...initialScenario.stages[0].environment,
          solarRadiationWm2: { start: 350, end: 350 },
        },
      }],
    };
    const presetScenario: SimulationScenario = {
      ...customScenario,
      stages: [{
        ...customScenario.stages[0],
        environment: {
          ...customScenario.stages[0].environment,
          solarRadiationWm2: { start: 600, end: 600 },
        },
      }],
    };
    const panel = (scenario: SimulationScenario) => (
      <ScenarioPanel
        scenario={scenario}
        selectedStageId={scenario.stages[0].id}
        issues={[]}
        language="zh"
        onChange={() => undefined}
        onSelectStage={() => undefined}
      />
    );
    const { rerender } = render(panel(customScenario));
    const solarGroup = screen.getByRole("group", { name: "太阳辐射" });
    const presetSelect = within(solarGroup).getByRole("combobox", { name: "日照条件" });

    expect(presetSelect).toHaveValue("custom");
    expect(within(solarGroup).getByRole("spinbutton", { name: "太阳辐射 W/m²" })).toHaveValue(350);

    rerender(panel(presetScenario));

    expect(presetSelect).toHaveValue("sunny");
    expect(within(solarGroup).queryByRole("spinbutton")).not.toBeInTheDocument();
  });
});
