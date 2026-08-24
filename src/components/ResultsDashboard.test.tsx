import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSingleStageScenario } from "../data/templates";
import { BODY_SEGMENTS, type Language, type SimulationResult } from "../domain/types";
import { ResultsDashboard } from "./ResultsDashboard";

afterEach(cleanup);

function makeResult(
  comfortScore: number,
  instantComfortScore?: number,
  sampleCount = 1,
): SimulationResult {
  const series = (value: number) => Array.from({ length: sampleCount }, () => value);
  const regionalMatrix = Array.from(
    { length: sampleCount },
    () => BODY_SEGMENTS.map(() => 35),
  );

  return {
    schemaVersion: 1,
    finalTemp: 36.8,
    coreTemp: 36.8,
    finalSkinTemp: 33,
    comfortScore,
    vasoActive: false,
    dilateActive: false,
    shiverActive: false,
    sweatActive: false,
    finalState: {
      heatProductionWatts: 100,
      solarHeatGainWatts: 0,
      heatLossResp: 5,
      heatLossDry: 40,
      sweatingHeatLoss: 0,
      skinLatentHeatLoss: 0,
      netHeatRateWatts: 55,
      shiveringIntensity: 0,
      sweatingIntensity: 0,
      vasoconstrictionIntensity: 0,
      vasodilationIntensity: 0,
    },
    averages: {},
    dataHistory: {
      time: Array.from({ length: sampleCount }, (_, index) => index),
      coreTemp: series(36.8),
      skinTemp: series(33),
      heatProduction: series(100),
      solarGain: series(0),
      respiratoryLoss: series(5),
      dryLoss: series(40),
      sweatLoss: series(0),
      skinLatentLoss: series(0),
      netRate: series(55),
      totalGain: series(100),
      totalLoss: series(45),
      shiveringIntensity: series(0),
      sweatingIntensity: series(0),
      vasoconstrictionIntensity: series(0),
      vasodilationIntensity: series(0),
      comfortScore: series(comfortScore),
      ...(instantComfortScore === undefined
        ? {}
        : { instantComfortScore: series(instantComfortScore) }),
      totalSkinLoss: series(40),
    },
    stageRanges: [{
      id: "stage-1",
      name: "Stage 1",
      startMinute: 0,
      endMinute: Math.max(1, sampleCount - 1),
      resultStartIndex: 0,
      resultEndIndex: sampleCount - 1,
    }],
    stageSummaries: [],
    regionalMetrics: {
      regionIds: [...BODY_SEGMENTS],
      units: {
        Tsk: "degC",
        Tcr: "degC",
        Wet: "fraction",
        BFsk: "L/h",
        Mshiv: "W",
        Esweat: "W",
        THLsk: "W",
        Icl: "clo",
      },
      Tsk: regionalMatrix,
      Tcr: regionalMatrix,
      Wet: regionalMatrix,
      BFsk: regionalMatrix,
      Mshiv: regionalMatrix,
      Esweat: regionalMatrix,
      THLsk: regionalMatrix,
      Icl: regionalMatrix,
    },
    jos3: { version: "0.5.0", results: {} },
  };
}

function renderDashboard(
  result: SimulationResult,
  language: Language,
  selectedIndex = 0,
  onSelectIndex: (index: number) => void = () => undefined,
) {
  render(
    <ResultsDashboard
      scenario={createSingleStageScenario()}
      result={result}
      status="ready"
      stale={false}
      selectedIndex={selectedIndex}
      selectedSegment="Head"
      metricKey="Tsk"
      language={language}
      onSelectIndex={onSelectIndex}
      onSelectSegment={() => undefined}
      onSelectMetric={() => undefined}
    />,
  );
}

function getComfortCard(label: string): HTMLElement {
  const card = screen.getByText(label).closest("article");
  if (!card) {
    throw new Error(`Expected a summary card for ${label}`);
  }
  return card;
}

describe("ResultsDashboard comfort summary", () => {
  it("shows the instant score without the Chinese heuristic label", () => {
    renderDashboard(makeResult(41, 82), "zh");

    const card = getComfortCard("即时舒适度");
    expect(within(card).getByText("82 / 100")).toBeVisible();
    expect(within(card).queryByText(/启发式/)).not.toBeInTheDocument();
  });

  it("falls back to the legacy score without the English heuristic label", () => {
    renderDashboard(makeResult(64), "en");

    const card = getComfortCard("Instant comfort");
    expect(within(card).getByText("64 / 100")).toBeVisible();
    expect(within(card).queryByText(/heuristic/i)).not.toBeInTheDocument();
  });
});

describe("ResultsDashboard playback", () => {
  it("restarts from the first sample when play is pressed at the end", () => {
    const onSelectIndex = vi.fn();
    renderDashboard(makeResult(64, undefined, 3), "zh", 2, onSelectIndex);

    const playButton = screen.getByRole("button", { name: /播放/ });
    fireEvent.click(playButton);

    expect(onSelectIndex).toHaveBeenCalledOnce();
    expect(onSelectIndex).toHaveBeenCalledWith(0);
    expect(screen.getByRole("button", { name: /暂停/ })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
  });
});

describe("ResultsDashboard advanced data", () => {
  it("shows an explicit disclosure marker and moves the model version to the footer", async () => {
    const user = userEvent.setup();
    renderDashboard(makeResult(64), "zh");

    const title = screen.getByText("高级数据");
    const summary = title.closest("summary");
    if (!(summary instanceof HTMLElement)) {
      throw new Error("Advanced data summary was not rendered.");
    }
    const details = summary.closest("details");
    if (!(details instanceof HTMLElement)) {
      throw new Error("Advanced data disclosure was not rendered.");
    }
    const footer = screen.getByText(/实验模型结果/).closest(".model-notice");
    if (!(footer instanceof HTMLElement)) {
      throw new Error("Model footer was not rendered.");
    }

    expect(summary.querySelector(".advanced-data__disclosure")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(summary).not.toHaveTextContent("0.5.0");
    expect(screen.queryByText(/字段和单位来自/)).not.toBeInTheDocument();
    expect(within(footer).getByText("JOS-3 0.5.0")).toBeVisible();

    expect(details).not.toHaveAttribute("open");
    await user.click(summary);
    expect(details).toHaveAttribute("open");
  });
});
