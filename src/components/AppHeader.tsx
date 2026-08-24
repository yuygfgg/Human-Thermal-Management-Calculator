import { useRef } from "react";

import { SCENARIO_TEMPLATES } from "../data/templates";
import type { Language, Theme } from "../domain/types";
import type { SimulationEngineStatus } from "../lib/simulationClient";

interface AppHeaderProps {
  scenarioName: string;
  selectedTemplateId: string;
  language: Language;
  theme: Theme;
  status: SimulationEngineStatus;
  canRun: boolean;
  onScenarioNameChange: (name: string) => void;
  onLoadTemplate: (templateId: string) => void;
  onImportJson: (source: string) => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onToggleLanguage: () => void;
  onToggleTheme: () => void;
  onRun: () => void;
  onCancel: () => void;
}

const COPY = {
  zh: {
    brand: "人体热管理",
    product: "多阶段热生理工作台",
    scenarioName: "场景名称",
    templates: "载入模板",
    chooseTemplate: "选择模板",
    importJson: "导入 JSON",
    exportJson: "导出 JSON",
    exportCsv: "导出 CSV",
    language: "Switch to English",
    light: "切换浅色主题",
    dark: "切换深色主题",
    run: "运行场景",
    cancel: "取消计算",
  },
  en: {
    brand: "Human Thermal",
    product: "Multi-stage physiology workbench",
    scenarioName: "Scenario name",
    templates: "Load template",
    chooseTemplate: "Choose template",
    importJson: "Import JSON",
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    language: "切换到中文",
    light: "Use light theme",
    dark: "Use dark theme",
    run: "Run scenario",
    cancel: "Cancel run",
  },
} as const;

export function AppHeader({
  scenarioName,
  selectedTemplateId,
  language,
  theme,
  status,
  canRun,
  onScenarioNameChange,
  onLoadTemplate,
  onImportJson,
  onExportJson,
  onExportCsv,
  onToggleLanguage,
  onToggleTheme,
  onRun,
  onCancel,
}: AppHeaderProps) {
  const copy = COPY[language];
  const fileInput = useRef<HTMLInputElement>(null);
  const running = status === "running" || status === "loading";

  return (
    <header className="app-header">
      <div className="brand-block">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div>
          <strong>{copy.brand}</strong>
          <span>{copy.product}</span>
        </div>
      </div>

      <label className="scenario-name-field">
        <span className="sr-only">{copy.scenarioName}</span>
        <input value={scenarioName} onChange={(event) => onScenarioNameChange(event.target.value)} aria-label={copy.scenarioName} />
      </label>

      <nav className="app-actions" aria-label={copy.product}>
        <label className="template-select">
          <span className="sr-only">{copy.templates}</span>
          <select
            value={selectedTemplateId}
            aria-label={copy.templates}
            onChange={(event) => {
              if (event.target.value) {
                onLoadTemplate(event.target.value);
              }
            }}
          >
            <option value="" disabled>{copy.chooseTemplate}</option>
            {SCENARIO_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label[language]}</option>)}
          </select>
        </label>
        <div className="menu-group">
          <button type="button" className="icon-button icon-button--text" onClick={() => fileInput.current?.click()}>{copy.importJson}</button>
          <button type="button" className="icon-button icon-button--text" onClick={onExportJson} disabled={!canRun}>{copy.exportJson}</button>
          <button type="button" className="icon-button icon-button--text" onClick={onExportCsv} disabled={!canRun}>{copy.exportCsv}</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void file.text().then(onImportJson).catch(() => onImportJson(""));
              }
              event.target.value = "";
            }}
          />
        </div>
        <button type="button" className="icon-button header-toggle" title={copy.language} aria-label={copy.language} onClick={onToggleLanguage}>{language === "zh" ? "EN" : "中"}</button>
        <button type="button" className="icon-button header-toggle" title={theme === "dark" ? copy.light : copy.dark} aria-label={theme === "dark" ? copy.light : copy.dark} onClick={onToggleTheme}>{theme === "dark" ? "☼" : "◐"}</button>
        {running ? (
          <button type="button" className="button button--run button--cancel" onClick={onCancel}><span>■</span>{copy.cancel}</button>
        ) : (
          <button type="button" className="button button--run" disabled={!canRun} onClick={onRun}><span>▶</span>{copy.run}</button>
        )}
      </nav>
    </header>
  );
}
