import { useEffect, useMemo, useState } from "react";

import { REGIONAL_METRICS, SEGMENT_LABELS } from "../domain/constants";
import {
  BODY_SEGMENTS,
  type BodySegment,
  type Language,
  type RegionalMetricKey,
  type SimulationResult,
  type SimulationScenario,
} from "../domain/types";
import type { SimulationEngineStatus } from "../lib/simulationClient";
import { AdvancedData } from "./AdvancedData";
import { BodyMap } from "./BodyMap";
import { TrendChart, type TrendSeries } from "./TrendChart";
import { resolveMetricDomain } from "./visualization";

interface ResultsDashboardProps {
  scenario: SimulationScenario;
  result: SimulationResult | null;
  status: SimulationEngineStatus;
  statusDetail?: string;
  stale: boolean;
  selectedIndex: number;
  selectedSegment: BodySegment;
  metricKey: RegionalMetricKey;
  language: Language;
  onSelectIndex: (index: number) => void;
  onSelectSegment: (segment: BodySegment) => void;
  onSelectMetric: (metric: RegionalMetricKey) => void;
}

type TrendMode = "regional" | "temperature" | "balance";

const COPY = {
  zh: {
    title: "人体热状态",
    loading: "正在加载本地 JOS-3 引擎",
    running: "正在计算场景",
    ready: "仿真结果已就绪",
    error: "仿真失败",
    idle: "运行场景后显示结果",
    stale: "输入已变化，当前显示上一次运行结果。",
    noResultTitle: "场景已准备",
    core: "平均核心温度",
    skin: "平均皮肤温度",
    comfort: "即时舒适度",
    net: "净热变化率",
    time: "查看时间",
    play: "播放",
    pause: "暂停",
    stage: "当前阶段",
    metric: "人体指标",
    regionDetail: "部位详情",
    current: "当前值",
    stageDelta: "较阶段开始",
    range: "全程范围",
    regionalTrend: "局部指标",
    temperatureTrend: "全身温度",
    balanceTrend: "热平衡",
    mean: "17 节点平均",
    counterpart: "对侧部位",
    coreSeries: "核心温度",
    skinSeries: "皮肤温度",
    gainSeries: "总产热",
    lossSeries: "总散热",
    netSeries: "净变化率",
    responses: "生理反应",
    shivering: "战栗",
    sweating: "出汗",
    constriction: "血管收缩",
    dilation: "血管舒张",
    stageSummary: "阶段摘要",
    stageAverage: "阶段平均",
    finalCore: "结束核心温度",
    skinRange: "皮肤温度范围",
    modelNotice: "实验模型结果不构成医疗或安全建议。",
  },
  en: {
    title: "Body thermal state",
    loading: "Loading the local JOS-3 engine",
    running: "Calculating the scenario",
    ready: "Simulation result is ready",
    error: "Simulation failed",
    idle: "Run the scenario to see results",
    stale: "Inputs changed. The dashboard shows the previous run.",
    noResultTitle: "Scenario ready",
    core: "Mean core temperature",
    skin: "Mean skin temperature",
    comfort: "Instant comfort",
    net: "Net heat rate",
    time: "Inspection time",
    play: "Play",
    pause: "Pause",
    stage: "Current stage",
    metric: "Body metric",
    regionDetail: "Region detail",
    current: "Current value",
    stageDelta: "Since stage start",
    range: "Scenario range",
    regionalTrend: "Regional metric",
    temperatureTrend: "Whole-body temperature",
    balanceTrend: "Heat balance",
    mean: "17-node mean",
    counterpart: "Opposite side",
    coreSeries: "Core temperature",
    skinSeries: "Skin temperature",
    gainSeries: "Total heat production",
    lossSeries: "Total heat loss",
    netSeries: "Net heat rate",
    responses: "Physiological response",
    shivering: "Shivering",
    sweating: "Sweating",
    constriction: "Vasoconstriction",
    dilation: "Vasodilation",
    stageSummary: "Stage summary",
    stageAverage: "Stage average",
    finalCore: "End core temperature",
    skinRange: "Skin temperature range",
    modelNotice: "Experimental model output is not medical or safety advice.",
  },
} as const;

const STATUS_CLASS: Record<SimulationEngineStatus, string> = {
  idle: "neutral",
  loading: "loading",
  ready: "ready",
  running: "loading",
  error: "error",
};

function finiteValues(values: readonly number[]): number[] {
  return values.filter(Number.isFinite);
}

function mean(values: readonly number[]): number {
  const finite = finiteValues(values);
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : Number.NaN;
}

function counterpart(segment: BodySegment): BodySegment | null {
  if (segment.startsWith("L")) {
    return `R${segment.slice(1)}` as BodySegment;
  }
  if (segment.startsWith("R")) {
    return `L${segment.slice(1)}` as BodySegment;
  }
  return null;
}

function formatValue(value: number, decimals: number, unit: string): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(decimals)}${unit ? ` ${unit}` : ""}`;
}

function displayUnit(unit: string): string {
  if (unit === "degC") {
    return "°C";
  }
  if (unit === "fraction") {
    return "";
  }
  return unit;
}

function currentStageName(result: SimulationResult, index: number): string {
  const historyName = result.dataHistory.stageName?.[index];
  if (historyName) {
    return historyName;
  }
  return result.stageRanges.find((range) => (
    index >= range.resultStartIndex && index <= range.resultEndIndex
  ))?.name ?? result.stageRanges[0]?.name ?? "";
}

function stageStartIndex(result: SimulationResult, index: number): number {
  if (index === 0) {
    return 0;
  }
  return result.stageRanges.find((range) => (
    index >= range.resultStartIndex && index <= range.resultEndIndex
  ))?.resultStartIndex ?? 0;
}

function StatusBanner({
  status,
  detail,
  stale,
  language,
}: {
  status: SimulationEngineStatus;
  detail?: string;
  stale: boolean;
  language: Language;
}) {
  const copy = COPY[language];
  const text = status === "error" && detail ? detail : copy[status];
  return (
    <div className={`engine-status engine-status--${STATUS_CLASS[status]}`} role="status" aria-live="polite">
      <span className="engine-status__dot" aria-hidden="true" />
      <span>{text}</span>
      {stale ? <span className="engine-status__stale">{copy.stale}</span> : null}
    </div>
  );
}

function SummaryCards({
  result,
  index,
  language,
}: {
  result: SimulationResult;
  index: number;
  language: Language;
}) {
  const copy = COPY[language];
  const history = result.dataHistory;
  const instantComfort = history.instantComfortScore?.[index] ?? history.comfortScore[index];
  const cards = [
    { label: copy.core, value: formatValue(history.coreTemp[index], 2, "°C"), tone: "core" },
    { label: copy.skin, value: formatValue(history.skinTemp[index], 1, "°C"), tone: "skin" },
    { label: copy.comfort, value: formatValue(instantComfort, 0, "/ 100"), tone: "comfort" },
    { label: copy.net, value: formatValue(history.netRate[index], 1, "W"), tone: "net" },
  ];
  return (
    <div className="summary-cards">
      {cards.map((card) => (
        <article key={card.label} className={`summary-card summary-card--${card.tone}`}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </article>
      ))}
    </div>
  );
}

function ResponsePanel({ result, index, language }: { result: SimulationResult; index: number; language: Language }) {
  const copy = COPY[language];
  const history = result.dataHistory;
  const entries = [
    [copy.shivering, history.shiveringIntensity[index]],
    [copy.sweating, history.sweatingIntensity[index]],
    [copy.constriction, history.vasoconstrictionIntensity[index]],
    [copy.dilation, history.vasodilationIntensity[index]],
  ] as const;
  return (
    <section className="response-panel" aria-labelledby="responses-title">
      <h3 id="responses-title">{copy.responses}</h3>
      <div className="response-panel__grid">
        {entries.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <div className="response-meter" aria-label={`${label}: ${formatValue(value, 1, "%")}`}>
              <span style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
            </div>
            <strong>{formatValue(value, 1, "%")}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResultsDashboard({
  scenario,
  result,
  status,
  statusDetail,
  stale,
  selectedIndex,
  selectedSegment,
  metricKey,
  language,
  onSelectIndex,
  onSelectSegment,
  onSelectMetric,
}: ResultsDashboardProps) {
  const copy = COPY[language];
  const [playing, setPlaying] = useState(false);
  const [trendMode, setTrendMode] = useState<TrendMode>("regional");
  const metric = REGIONAL_METRICS.find((candidate) => candidate.key === metricKey)
    ?? REGIONAL_METRICS[0];
  const maximumIndex = Math.max(0, (result?.dataHistory.time.length ?? 1) - 1);
  const index = Math.min(maximumIndex, Math.max(0, selectedIndex));

  useEffect(() => {
    if (!playing || !result) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (index >= maximumIndex) {
        setPlaying(false);
        return;
      }
      onSelectIndex(index + 1);
    }, 220);
    return () => window.clearInterval(timer);
  }, [index, maximumIndex, onSelectIndex, playing, result]);

  useEffect(() => {
    setPlaying(false);
  }, [result]);

  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      return;
    }

    if (index >= maximumIndex) {
      onSelectIndex(0);
    }
    setPlaying(true);
  };

  const selectedSegmentIndex = BODY_SEGMENTS.indexOf(selectedSegment);
  const regionalMatrix = result?.regionalMetrics[metric.key] ?? [];
  const metricDomain = useMemo(
    () => resolveMetricDomain(metric, regionalMatrix),
    [metric, regionalMatrix],
  );
  const regionalValues = regionalMatrix[index] ?? [];
  const selectedSeries = regionalMatrix.map((row) => row[selectedSegmentIndex]);
  const oppositeSegment = counterpart(selectedSegment);
  const oppositeIndex = oppositeSegment ? BODY_SEGMENTS.indexOf(oppositeSegment) : -1;
  const oppositeSeries = oppositeIndex >= 0 ? regionalMatrix.map((row) => row[oppositeIndex]) : [];
  const meanSeries = regionalMatrix.map(mean);
  const unit = displayUnit(result?.regionalMetrics.units[metric.key] ?? "");
  const stageStart = result ? stageStartIndex(result, index) : 0;
  const currentRegionValue = selectedSeries[index];
  const stageDelta = currentRegionValue - selectedSeries[stageStart];
  const selectedFinite = finiteValues(selectedSeries);

  const trendSeries = useMemo<TrendSeries[]>(() => {
    if (!result) {
      return [];
    }
    if (trendMode === "temperature") {
      return [
        { id: "core", label: copy.coreSeries, values: result.dataHistory.coreTemp, color: "#bb5249" },
        { id: "skin", label: copy.skinSeries, values: result.dataHistory.skinTemp, color: "#287f9b" },
      ];
    }
    if (trendMode === "balance") {
      return [
        { id: "gain", label: copy.gainSeries, values: result.dataHistory.totalGain, color: "#4f8d5d" },
        { id: "loss", label: copy.lossSeries, values: result.dataHistory.totalLoss, color: "#287f9b" },
        { id: "net", label: copy.netSeries, values: result.dataHistory.netRate, color: "#d4743c" },
      ];
    }
    const series: TrendSeries[] = [
      { id: selectedSegment, label: SEGMENT_LABELS[selectedSegment][language], values: selectedSeries, color: "#d4743c" },
      { id: "mean", label: copy.mean, values: meanSeries, color: "#287f9b" },
    ];
    if (oppositeSegment) {
      series.push({ id: oppositeSegment, label: `${copy.counterpart}: ${SEGMENT_LABELS[oppositeSegment][language]}`, values: oppositeSeries, color: "#8170c9" });
    }
    return series;
  }, [copy, language, meanSeries, oppositeSegment, oppositeSeries, result, selectedSegment, selectedSeries, trendMode]);

  const trendUnit = trendMode === "regional" ? unit : trendMode === "temperature" ? "°C" : "W";
  const trendDomain = trendMode === "regional" ? metricDomain : undefined;

  return (
    <main className="results-dashboard">
      <div className="results-heading">
        <div>
          <p className="eyebrow">03</p>
          <h1>{copy.title}</h1>
        </div>
        <StatusBanner status={status} detail={statusDetail} stale={stale} language={language} />
      </div>

      {!result ? (
        <section className="results-placeholder">
          <div className="results-placeholder__figure" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{copy.noResultTitle}</h2>
        </section>
      ) : (
        <>
          <SummaryCards result={result} index={index} language={language} />

          <section className="time-controller" aria-labelledby="time-controller-title">
            <div className="time-controller__meta">
              <div>
                <span id="time-controller-title">{copy.time}</span>
                <strong>{result.dataHistory.time[index]?.toFixed(0) ?? index} min</strong>
              </div>
              <div>
                <span>{copy.stage}</span>
                <strong>{currentStageName(result, index)}</strong>
              </div>
              <button type="button" className="button button--secondary" onClick={togglePlayback}>
                {playing ? "Ⅱ" : "▶"} {playing ? copy.pause : copy.play}
              </button>
            </div>
            <input
              className="time-slider"
              type="range"
              min={0}
              max={maximumIndex}
              step={1}
              value={index}
              aria-label={copy.time}
              onChange={(event) => onSelectIndex(Number(event.target.value))}
            />
            <div className="time-controller__stages" aria-hidden="true">
              {result.stageRanges.map((range) => (
                <span key={range.id} style={{ flexGrow: Math.max(1, range.endMinute - range.startMinute) }}>{range.name}</span>
              ))}
            </div>
          </section>

          <section className="body-workspace">
            <div className="body-workspace__map">
              <div className="metric-tabs" role="tablist" aria-label={copy.metric}>
                {REGIONAL_METRICS.map((candidate) => (
                  <button
                    key={candidate.key}
                    type="button"
                    role="tab"
                    aria-selected={candidate.key === metric.key}
                    className={candidate.key === metric.key ? "metric-tab metric-tab--active" : "metric-tab"}
                    onClick={() => onSelectMetric(candidate.key)}
                  >
                    <span>{candidate.shortLabel}</span>
                    <small>{candidate.label[language]}</small>
                  </button>
                ))}
              </div>
              <BodyMap metric={metric} values={regionalValues} unit={unit} selectedSegment={selectedSegment} language={language} onSelectSegment={onSelectSegment} domain={metricDomain} />
            </div>

            <aside className="region-inspector" aria-labelledby="region-detail-title">
              <p className="eyebrow">{metric.shortLabel}</p>
              <h2 id="region-detail-title">{SEGMENT_LABELS[selectedSegment][language]}</h2>
              <div className="region-inspector__primary">
                <span>{copy.current}</span>
                <strong>{formatValue(currentRegionValue, metric.decimals, unit)}</strong>
              </div>
              <dl className="region-stats">
                <div><dt>{copy.stageDelta}</dt><dd>{formatValue(stageDelta, metric.decimals, unit)}</dd></div>
                <div><dt>{copy.range}</dt><dd>{selectedFinite.length ? `${formatValue(Math.min(...selectedFinite), metric.decimals, unit)} – ${formatValue(Math.max(...selectedFinite), metric.decimals, unit)}` : "—"}</dd></div>
              </dl>
              <ResponsePanel result={result} index={index} language={language} />
            </aside>
          </section>

          <section className="trend-section" aria-labelledby="trend-title">
            <div className="trend-section__heading">
              <h2 id="trend-title">{trendMode === "regional" ? copy.regionalTrend : trendMode === "temperature" ? copy.temperatureTrend : copy.balanceTrend}</h2>
              <div className="segmented-control" role="tablist">
                {([
                  ["regional", copy.regionalTrend],
                  ["temperature", copy.temperatureTrend],
                  ["balance", copy.balanceTrend],
                ] as const).map(([mode, label]) => (
                  <button key={mode} type="button" role="tab" aria-selected={trendMode === mode} onClick={() => setTrendMode(mode)}>{label}</button>
                ))}
              </div>
            </div>
            <TrendChart times={result.dataHistory.time} series={trendSeries} stageRanges={result.stageRanges} selectedIndex={index} language={language} onSelectIndex={onSelectIndex} unit={trendUnit} yDomain={trendDomain} />
          </section>

          <section className="stage-summary" aria-labelledby="stage-summary-title">
            <div className="section-heading"><h2 id="stage-summary-title">{copy.stageSummary}</h2></div>
            <div className="stage-summary__grid">
              {result.stageSummaries.map((summary) => (
                <article key={summary.id}>
                  <span>{summary.startMinute}–{summary.endMinute} min</span>
                  <h3>{summary.name}</h3>
                  <dl>
                    <div><dt>{copy.finalCore}</dt><dd>{formatValue(summary.final.coreTempC, 2, "°C")}</dd></div>
                    <div><dt>{copy.stageAverage}</dt><dd>{formatValue(summary.averages.comfortScore, 0, "/100")}</dd></div>
                    <div><dt>{copy.skinRange}</dt><dd>{formatValue(summary.extrema.skinTempMinC, 1, "°C")} – {formatValue(summary.extrema.skinTempMaxC, 1, "°C")}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <AdvancedData result={result} language={language} selectedIndex={index} onSelectIndex={onSelectIndex} />
        </>
      )}

      <p className="model-notice">
        <span>{copy.modelNotice}</span>
        {result?.jos3.version ? (
          <span className="model-version">JOS-3 {result.jos3.version}</span>
        ) : null}
      </p>
      <span className="sr-only">{scenario.name}</span>
    </main>
  );
}
