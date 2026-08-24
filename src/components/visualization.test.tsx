import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REGIONAL_METRICS } from "../domain/constants";
import { BODY_SEGMENTS, type StageRange } from "../domain/types";
import { BodyMap } from "./BodyMap";
import { TrendChart, type TrendSeries } from "./TrendChart";
import {
  colorForMetricValue,
  finiteDomain,
  nearestTimeIndex,
  resolveMetricDomain,
} from "./visualization";

afterEach(cleanup);

const stageRanges: StageRange[] = [
  {
    id: "stage-1",
    name: "Indoor",
    startMinute: 0,
    endMinute: 10,
    resultStartIndex: 0,
    resultEndIndex: 1,
  },
  {
    id: "stage-2",
    name: "Outdoor",
    startMinute: 10,
    endMinute: 20,
    resultStartIndex: 1,
    resultEndIndex: 2,
  },
];

const trendSeries: TrendSeries[] = [
  { id: "head", label: "Head", values: [35, 35.5, 36] },
  { id: "chest", label: "Chest", values: [34, 34.5, 35] },
  { id: "hand", label: "Hand", values: [31, 30, 29] },
  { id: "foot", label: "Foot", values: [30, 29, 28] },
];

describe("BodyMap", () => {
  it("maps all 17 JOS-3 segments to accessible selectable regions", () => {
    const onSelectSegment = vi.fn();
    const values = BODY_SEGMENTS.map((_, index) => 30 + index / 10);
    const { container } = render(
      <BodyMap
        metric={REGIONAL_METRICS[0]}
        values={values}
        unit="°C"
        selectedSegment="Head"
        language="en"
        onSelectSegment={onSelectSegment}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(17);
    expect(container.querySelectorAll("[data-segment]")).toHaveLength(17);
    BODY_SEGMENTS.forEach((segment) => {
      expect(container.querySelector(`[data-segment="${segment}"]`)).toBeInTheDocument();
    });

    const chest = screen.getByRole("button", { name: "Chest: 30.2 °C" });
    expect(screen.getByRole("button", { name: "Back: 30.3 °C" })).toBeInTheDocument();
    fireEvent.click(chest);
    expect(onSelectSegment).toHaveBeenCalledWith("Chest");
  });

  it("uses roving keyboard selection and exposes the selected region", () => {
    const onSelectSegment = vi.fn();
    render(
      <BodyMap
        metric={REGIONAL_METRICS[0]}
        values={BODY_SEGMENTS.map(() => 35)}
        unit="°C"
        selectedSegment="Head"
        language="en"
        onSelectSegment={onSelectSegment}
      />,
    );

    const head = screen.getByRole("button", { name: "Head: 35.0 °C" });
    const neck = screen.getByRole("button", { name: "Neck: 35.0 °C" });
    expect(head).toHaveAttribute("aria-pressed", "true");
    expect(head).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(head, { key: "ArrowRight" });
    expect(onSelectSegment).toHaveBeenCalledWith("Neck");
    expect(neck).toHaveFocus();
  });

  it("derives every back-view region from one shared mirror transform", () => {
    const { container } = render(
      <BodyMap
        metric={REGIONAL_METRICS[0]}
        values={BODY_SEGMENTS.map(() => 35)}
        unit="°C"
        selectedSegment="Head"
        language="en"
        onSelectSegment={() => undefined}
      />,
    );

    const pairedSegments = BODY_SEGMENTS.filter((segment) => (
      segment !== "Chest" && segment !== "Back"
    ));

    pairedSegments.forEach((segment) => {
      const paths = container.querySelectorAll(`[data-segment="${segment}"] path`);
      expect(paths).toHaveLength(2);
      expect(paths[1]).toHaveAttribute("d", paths[0].getAttribute("d"));
      expect(paths[1]).toHaveAttribute("transform", "matrix(-1 0 0 1 935 0)");
    });

    const chest = container.querySelector('[data-segment="Chest"] path');
    const back = container.querySelector('[data-segment="Back"] path');
    expect(back).toHaveAttribute("d", chest?.getAttribute("d"));
    expect(back).toHaveAttribute("transform", "matrix(-1 0 0 1 935 0)");
  });

  it("shows missing regional samples without changing the fixed legend domain", () => {
    const { container } = render(
      <BodyMap
        metric={REGIONAL_METRICS[0]}
        values={[Number.NaN]}
        unit="°C"
        selectedSegment="Head"
        language="zh"
        onSelectSegment={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "头部: —" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "颈部: —" })).toBeInTheDocument();
    expect(screen.getByText("15.0 °C")).toBeInTheDocument();
    expect(screen.getByText("38.0 °C")).toBeInTheDocument();
    expect(container.querySelector('[data-segment="Head"] path')).toHaveAttribute(
      "fill",
      "#c8ced3",
    );
  });
});

describe("TrendChart", () => {
  it("renders stage bands, boundaries, and no more than three series", () => {
    const { container } = render(
      <TrendChart
        times={[0, 10, 20]}
        series={trendSeries}
        stageRanges={stageRanges}
        selectedIndex={1}
        language="en"
        unit="°C"
        onSelectIndex={() => undefined}
      />,
    );

    expect(container.querySelectorAll("[data-series-id]")).toHaveLength(3);
    expect(container.querySelector('[data-series-id="foot"]')).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-stage-id]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-stage-boundary]")).toHaveLength(1);
    expect(screen.getByRole("slider", { name: "Select inspection time" })).toHaveAttribute(
      "aria-valuenow",
      "10",
    );
  });

  it("moves the time cursor with the keyboard and pointer", () => {
    const onSelectIndex = vi.fn();
    const { container } = render(
      <TrendChart
        times={[0, 10, 20]}
        series={trendSeries.slice(0, 1)}
        stageRanges={stageRanges}
        selectedIndex={0}
        language="en"
        onSelectIndex={onSelectIndex}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Select inspection time" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSelectIndex).toHaveBeenLastCalledWith(1);

    const svg = container.querySelector("svg");
    if (!svg) {
      throw new Error("Expected the trend SVG to exist");
    }
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 900,
      height: 410,
      top: 0,
      right: 900,
      bottom: 410,
      left: 0,
      toJSON: () => ({}),
    });
    const interactionRect = slider.querySelector("rect");
    if (!interactionRect) {
      throw new Error("Expected the trend interaction area to exist");
    }
    fireEvent.click(interactionRect, { clientX: 472 });
    expect(onSelectIndex).toHaveBeenLastCalledWith(1);
  });

  it("uses localized empty-state copy", () => {
    render(
      <TrendChart
        times={[]}
        series={[]}
        stageRanges={[]}
        selectedIndex={0}
        language="zh"
        onSelectIndex={() => undefined}
      />,
    );

    expect(screen.getByText("没有可显示的趋势数据")).toBeInTheDocument();
  });
});

describe("visualization helpers", () => {
  it("clamps metric colors to the fixed metric domain", () => {
    const metric = REGIONAL_METRICS[0];
    const domain = resolveMetricDomain(metric, []);
    expect(colorForMetricValue(metric, -100)).toBe(colorForMetricValue(metric, domain[0]));
    expect(colorForMetricValue(metric, 100)).toBe(colorForMetricValue(metric, domain[1]));
  });

  it("derives a scenario-wide upper bound for shivering heat", () => {
    const metric = REGIONAL_METRICS.find((candidate) => candidate.key === "Mshiv");
    if (!metric) {
      throw new Error("Expected the Mshiv metric definition");
    }

    expect(resolveMetricDomain(metric, [[0, 26.34], [37.27, 0.02]])).toEqual([0, 40]);
    expect(resolveMetricDomain(metric, [[0, 0]])).toEqual([0, 1]);
  });

  it("creates stable domains and locates irregular time samples", () => {
    expect(finiteDomain([[5, 5]])).toEqual([4, 6]);
    expect(nearestTimeIndex([0, 3, 20], 12)).toBe(2);
  });
});
