import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

const SCENARIO_STORAGE_KEY = "thermal-workbench-scenario-v1";
const storedValues = new Map<string, string>();
const storage: Storage = {
  get length() {
    return storedValues.size;
  },
  clear: () => storedValues.clear(),
  getItem: (key) => storedValues.get(key) ?? null,
  key: (index) => [...storedValues.keys()][index] ?? null,
  removeItem: (key) => {
    storedValues.delete(key);
  },
  setItem: (key, value) => {
    storedValues.set(key, value);
  },
};

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("keeps the template selector synchronized with the loaded scenario", async () => {
    const user = userEvent.setup();
    render(<App />);

    const templateSelect = screen.getByRole("combobox", { name: "载入模板" });
    const scenarioName = screen.getByRole("textbox", { name: "场景名称" });
    expect(templateSelect).toHaveValue("winter-commute");

    await user.selectOptions(templateSelect, "exercise-recovery");
    expect(templateSelect).toHaveValue("exercise-recovery");
    expect(scenarioName).toHaveValue("Exercise and recovery");

    await user.selectOptions(templateSelect, "single-stage");
    expect(templateSelect).toHaveValue("single-stage");
    expect(scenarioName).toHaveValue("Single exposure");

    await user.type(scenarioName, " custom");
    expect(templateSelect).toHaveValue("");

    await user.selectOptions(templateSelect, "single-stage");
    expect(templateSelect).toHaveValue("single-stage");
    expect(scenarioName).toHaveValue("Single exposure");
  });

  it("edits a stage profile and duplicates a stage from the timeline", async () => {
    const user = userEvent.setup();
    render(<App />);

    const timeline = screen.getByRole("list", { name: "场景时间线" });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(3);

    await user.click(screen.getAllByRole("checkbox", { name: "阶段内变化" })[0]);
    expect(screen.getByRole("spinbutton", { name: "空气温度 · 起值 °C" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "空气温度 · 终值 °C" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /复制$/ }));
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(4);
  });

  it("keeps the last valid draft and disables actions while an edit is invalid", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(localStorage.getItem(SCENARIO_STORAGE_KEY)).not.toBeNull());
    const validDraft = localStorage.getItem(SCENARIO_STORAGE_KEY);

    await user.clear(screen.getByRole("textbox", { name: "场景名称" }));

    expect(screen.getByRole("button", { name: /运行场景/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出 JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeDisabled();
    expect(screen.getByText("请修正以下输入")).toBeVisible();
    await waitFor(() => expect(localStorage.getItem(SCENARIO_STORAGE_KEY)).toBe(validDraft));
  });
});
