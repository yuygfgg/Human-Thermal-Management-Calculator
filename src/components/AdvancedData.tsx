import { useMemo, useState } from "react";

import type { Language, SimulationResult } from "../domain/types";
import { TrendChart } from "./TrendChart";

interface AdvancedDataProps {
  result: SimulationResult;
  language: Language;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}

const COPY = {
  zh: {
    title: "高级数据",
    search: "筛选字段",
    key: "参数",
    noMatches: "没有匹配字段。",
    recent: "当前时间附近的数据",
    time: "时间",
    value: "值",
  },
  en: {
    title: "Advanced data",
    search: "Filter keys",
    key: "Parameter",
    noMatches: "No matching keys.",
    recent: "Values near the selected time",
    time: "Time",
    value: "Value",
  },
} as const;

function numericSeries(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = value.map((item) => Number(item));
  return parsed.every(Number.isFinite) ? parsed : null;
}

export function AdvancedData({
  result,
  language,
  selectedIndex,
  onSelectIndex,
}: AdvancedDataProps) {
  const copy = COPY[language];
  const [filter, setFilter] = useState("");
  const keys = useMemo(() => Object.entries(result.jos3.results)
    .filter(([key, value]) => key !== "ModTime" && numericSeries(value))
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right)), [result]);
  const filteredKeys = keys.filter((key) => key.toLowerCase().includes(filter.toLowerCase()));
  const [requestedKey, setRequestedKey] = useState("TskHead");
  const selectedKey = filteredKeys.includes(requestedKey)
    ? requestedKey
    : filteredKeys[0] ?? keys[0] ?? "";
  const values = numericSeries(result.jos3.results[selectedKey]) ?? [];
  const rowStart = Math.max(0, selectedIndex - 3);
  const rowEnd = Math.min(values.length, selectedIndex + 4);

  return (
    <details className="advanced-data">
      <summary>
        <span className="advanced-data__disclosure" aria-hidden="true" />
        <span>{copy.title}</span>
      </summary>
      <div className="advanced-data__content">
        <div className="field-grid">
          <label className="field">
            <span className="field__label">{copy.search}</span>
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Tsk, BFsk, THLsk…" />
          </label>
          <label className="field">
            <span className="field__label">{copy.key}</span>
            <select value={selectedKey} onChange={(event) => setRequestedKey(event.target.value)} disabled={filteredKeys.length === 0}>
              {filteredKeys.map((key) => <option key={key}>{key}</option>)}
            </select>
          </label>
        </div>
        {selectedKey ? (
          <>
            <TrendChart
              times={result.dataHistory.time}
              series={[{ id: selectedKey, label: selectedKey, values, color: "#d4743c" }]}
              stageRanges={result.stageRanges}
              selectedIndex={selectedIndex}
              language={language}
              onSelectIndex={onSelectIndex}
              className="advanced-data__chart"
            />
            <div className="raw-table-wrap">
              <table className="raw-table">
                <caption>{copy.recent}</caption>
                <thead><tr><th>{copy.time}</th><th>{selectedKey}</th></tr></thead>
                <tbody>
                  {values.slice(rowStart, rowEnd).map((value, offset) => {
                    const index = rowStart + offset;
                    return (
                      <tr key={index} className={index === selectedIndex ? "raw-table__selected" : ""}>
                        <td>{result.dataHistory.time[index]?.toFixed(0) ?? index} min</td>
                        <td>{value.toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : <p className="empty-state">{copy.noMatches}</p>}
      </div>
    </details>
  );
}
