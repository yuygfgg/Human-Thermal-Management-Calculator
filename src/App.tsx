import { useEffect, useMemo, useReducer, useState } from "react";

import { AppHeader } from "./components/AppHeader";
import { ResultsDashboard } from "./components/ResultsDashboard";
import { ScenarioPanel } from "./components/ScenarioPanel";
import { REGIONAL_METRICS } from "./domain/constants";
import { toSimulationPayload, validateScenario } from "./domain/scenario";
import type {
  BodySegment,
  Language,
  RegionalMetricKey,
  SimulationResult,
  SimulationScenario,
  Theme,
} from "./domain/types";
import { SCENARIO_TEMPLATES, createWinterCommuteScenario } from "./data/templates";
import {
  parseScenarioJson,
  serializeScenarioCsv,
  serializeScenarioJson,
} from "./lib/scenarioFiles";
import {
  SimulationClient,
  type SimulationEngineStatus,
} from "./lib/simulationClient";

const STORAGE_KEY = "thermal-workbench-scenario-v1";
const PREFERENCES_KEY = "thermal-workbench-preferences-v1";

interface AppState {
  scenario: SimulationScenario;
  selectedTemplateId: string;
  selectedStageId: string;
  result: SimulationResult | null;
  resultScenario: string | null;
  selectedIndex: number;
  selectedSegment: BodySegment;
  metricKey: RegionalMetricKey;
  status: SimulationEngineStatus;
  statusDetail?: string;
}

type AppAction =
  | { type: "scenario/change"; scenario: SimulationScenario }
  | { type: "scenario/replace"; scenario: SimulationScenario; templateId: string }
  | { type: "stage/select"; stageId: string }
  | { type: "simulation/status"; status: SimulationEngineStatus; detail?: string }
  | { type: "simulation/success"; result: SimulationResult; fingerprint: string }
  | { type: "time/select"; index: number }
  | { type: "segment/select"; segment: BodySegment }
  | { type: "metric/select"; metric: RegionalMetricKey };

function scenarioFingerprint(scenario: SimulationScenario): string {
  return JSON.stringify(scenario);
}

function loadInitialScenario(): {
  scenario: SimulationScenario;
  templateId: string;
} {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { scenario: parseScenarioJson(stored), templateId: "" };
    }
  } catch {
    // Fall through to the built-in default when storage is unavailable or invalid.
  }
  return { scenario: createWinterCommuteScenario(), templateId: "winter-commute" };
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "scenario/change": {
      const selectedStageId = action.scenario.stages.some((stage) => stage.id === state.selectedStageId)
        ? state.selectedStageId
        : action.scenario.stages[0]?.id ?? "";
      return {
        ...state,
        scenario: action.scenario,
        selectedTemplateId: "",
        selectedStageId,
      };
    }
    case "scenario/replace":
      return {
        ...state,
        scenario: action.scenario,
        selectedTemplateId: action.templateId,
        selectedStageId: action.scenario.stages[0]?.id ?? "",
        result: null,
        resultScenario: null,
        selectedIndex: 0,
        status: "idle",
        statusDetail: undefined,
      };
    case "stage/select":
      return { ...state, selectedStageId: action.stageId };
    case "simulation/status":
      return { ...state, status: action.status, statusDetail: action.detail };
    case "simulation/success":
      return {
        ...state,
        result: action.result,
        resultScenario: action.fingerprint,
        selectedIndex: Math.max(0, action.result.dataHistory.time.length - 1),
        status: "ready",
        statusDetail: undefined,
      };
    case "time/select":
      return { ...state, selectedIndex: action.index };
    case "segment/select":
      return { ...state, selectedSegment: action.segment };
    case "metric/select":
      return { ...state, metricKey: action.metric };
  }
}

function initialState(): AppState {
  const { scenario, templateId } = loadInitialScenario();
  return {
    scenario,
    selectedTemplateId: templateId,
    selectedStageId: scenario.stages[0]?.id ?? "",
    result: null,
    resultScenario: null,
    selectedIndex: 0,
    selectedSegment: "Chest",
    metricKey: REGIONAL_METRICS[0].key,
    status: "idle",
  };
}

function initialPreferences(): { language: Language; theme: Theme } {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as {
      language?: Language;
      theme?: Theme;
    } | null;
    const language = parsed?.language === "en" ? "en" : "zh";
    const systemLight = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
    const theme = parsed?.theme === "light" || parsed?.theme === "dark"
      ? parsed.theme
      : systemLight ? "light" : "dark";
    return { language, theme };
  } catch {
    return { language: "zh", theme: "dark" };
  }
}

function downloadText(source: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([source], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(name: string): string {
  const normalized = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return normalized || "thermal-scenario";
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [notification, setNotification] = useState<string | null>(null);
  const [client] = useState(() => new SimulationClient());
  const issues = useMemo(() => validateScenario(state.scenario), [state.scenario]);
  const fingerprint = useMemo(() => scenarioFingerprint(state.scenario), [state.scenario]);
  const stale = state.result !== null && state.resultScenario !== fingerprint;

  useEffect(() => client.subscribe((event) => {
    dispatch({ type: "simulation/status", status: event.status, detail: event.detail });
  }), [client]);

  useEffect(() => () => client.destroy(), [client]);

  useEffect(() => {
    if (issues.length > 0) {
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, serializeScenarioJson(state.scenario));
    } catch {
      // Storage can be unavailable in privacy modes. The in-memory draft remains usable.
    }
  }, [issues.length, state.scenario]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.lang = preferences.language === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // The selected preferences still apply for the current session.
    }
  }, [preferences]);

  const cancelActiveRun = () => {
    if (state.status === "loading" || state.status === "running") {
      client.cancel();
    }
  };
  const changeScenario = (scenario: SimulationScenario) => {
    cancelActiveRun();
    dispatch({ type: "scenario/change", scenario });
  };
  const replaceScenario = (scenario: SimulationScenario, templateId = "") => {
    cancelActiveRun();
    dispatch({ type: "scenario/replace", scenario, templateId });
  };

  const runSimulation = async () => {
    if (issues.length > 0) {
      setNotification(preferences.language === "zh" ? "场景包含无效输入。" : "The scenario contains invalid inputs.");
      return;
    }
    const runFingerprint = fingerprint;
    try {
      const result = await client.run(toSimulationPayload(state.scenario));
      dispatch({ type: "simulation/success", result, fingerprint: runFingerprint });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "simulation/status", status: "error", detail: message });
      setNotification(message);
    }
  };

  const loadTemplate = (templateId: string) => {
    const template = SCENARIO_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (template) {
      replaceScenario(template.create(), template.id);
    }
  };

  const importJson = (source: string) => {
    try {
      const scenario = parseScenarioJson(source);
      replaceScenario(scenario);
      setNotification(preferences.language === "zh" ? "场景已导入。" : "Scenario imported.");
    } catch (error) {
      setNotification(error instanceof Error ? error.message : String(error));
    }
  };

  const filename = safeFilename(state.scenario.name);

  return (
    <div className="app-shell">
      <AppHeader
        scenarioName={state.scenario.name}
        selectedTemplateId={state.selectedTemplateId}
        language={preferences.language}
        theme={preferences.theme}
        status={state.status}
        canRun={issues.length === 0}
        onScenarioNameChange={(name) => changeScenario({ ...state.scenario, name })}
        onLoadTemplate={loadTemplate}
        onImportJson={importJson}
        onExportJson={() => downloadText(serializeScenarioJson(state.scenario), `${filename}.json`, "application/json;charset=utf-8")}
        onExportCsv={() => downloadText(serializeScenarioCsv(state.scenario, stale ? null : state.result), `${filename}.csv`, "text/csv;charset=utf-8")}
        onToggleLanguage={() => setPreferences((value) => ({ ...value, language: value.language === "zh" ? "en" : "zh" }))}
        onToggleTheme={() => setPreferences((value) => ({ ...value, theme: value.theme === "dark" ? "light" : "dark" }))}
        onRun={() => void runSimulation()}
        onCancel={() => client.cancel()}
      />

      <div className="workspace-layout">
        <ScenarioPanel
          scenario={state.scenario}
          selectedStageId={state.selectedStageId}
          issues={issues}
          language={preferences.language}
          onChange={changeScenario}
          onSelectStage={(stageId) => dispatch({ type: "stage/select", stageId })}
        />
        <ResultsDashboard
          scenario={state.scenario}
          result={state.result}
          status={state.status}
          statusDetail={state.statusDetail}
          stale={stale}
          selectedIndex={state.selectedIndex}
          selectedSegment={state.selectedSegment}
          metricKey={state.metricKey}
          language={preferences.language}
          onSelectIndex={(index) => dispatch({ type: "time/select", index })}
          onSelectSegment={(segment) => dispatch({ type: "segment/select", segment })}
          onSelectMetric={(metric) => dispatch({ type: "metric/select", metric })}
        />
      </div>

      {notification ? (
        <div className="toast" role="alert">
          <span>{notification}</span>
          <button type="button" aria-label={preferences.language === "zh" ? "关闭" : "Dismiss"} onClick={() => setNotification(null)}>×</button>
        </div>
      ) : null}
    </div>
  );
}
