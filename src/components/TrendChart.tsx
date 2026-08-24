import { useId, type KeyboardEvent, type MouseEvent } from "react";

import type { Language, StageRange } from "../domain/types";
import {
  clampIndex,
  finiteDomain,
  nearestIndexForPosition,
  nearestTimeIndex,
} from "./visualization";

export interface TrendSeries {
  id: string;
  label: string;
  values: readonly number[];
  color?: string;
}

export interface TrendChartProps {
  times: readonly number[];
  series: readonly TrendSeries[];
  stageRanges: readonly StageRange[];
  selectedIndex: number;
  language: Language;
  onSelectIndex: (index: number) => void;
  unit?: string;
  yDomain?: readonly [number, number];
  className?: string;
}

const CHART_WIDTH = 900;
const CHART_HEIGHT = 410;
const PLOT = { left: 68, right: 876, top: 65, bottom: 346 } as const;
const DEFAULT_COLORS = ["#d34a4f", "#287f9b", "#8170c9"] as const;
const STAGE_COLORS = ["#4f7fbf", "#4f9a79", "#c38a43", "#8b6eb3"] as const;

const COPY = {
  zh: {
    chart: "时间趋势图",
    noData: "没有可显示的趋势数据",
    timeAxis: "时间（分钟）",
    valueAxis: "数值",
    selectTime: "选择查看时间",
    minute: "分钟",
  },
  en: {
    chart: "Time trend chart",
    noData: "No trend data is available",
    timeAxis: "Time (min)",
    valueAxis: "Value",
    selectTime: "Select inspection time",
    minute: "minutes",
  },
} as const;

function scaleLinear(
  value: number,
  domainStart: number,
  domainEnd: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  if (domainEnd === domainStart) {
    return (rangeStart + rangeEnd) / 2;
  }
  return rangeStart + ((value - domainStart) / (domainEnd - domainStart)) * (rangeEnd - rangeStart);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatAxisValue(value: number, language: Language): string {
  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSeriesValue(value: number | undefined, unit: string, language: Language): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const suffix = unit ? ` ${unit}` : "";
  return `${formatAxisValue(value, language)}${suffix}`;
}

function linePath(
  times: readonly number[],
  values: readonly number[],
  xScale: (time: number) => number,
  yScale: (value: number) => number,
): string {
  let path = "";
  let activeSubpath = false;

  for (let index = 0; index < Math.min(times.length, values.length); index += 1) {
    const time = times[index];
    const value = values[index];
    if (!Number.isFinite(time) || !Number.isFinite(value)) {
      activeSubpath = false;
      continue;
    }
    path += `${activeSubpath ? " L" : "M"}${xScale(time).toFixed(2)} ${yScale(value).toFixed(2)}`;
    activeSubpath = true;
  }

  return path;
}

export function TrendChart({
  times,
  series,
  stageRanges,
  selectedIndex,
  language,
  onSelectIndex,
  unit = "",
  yDomain,
  className = "",
}: TrendChartProps) {
  const titleId = useId();
  const descriptionId = useId();
  const clipId = `${useId().replaceAll(":", "")}-trend-clip`;
  const copy = COPY[language];
  const visibleSeries = series.slice(0, 3);
  const pointCount = times.length;

  if (pointCount === 0 || visibleSeries.length === 0) {
    return (
      <figure className={`trend-chart trend-chart--empty ${className}`.trim()}>
        <figcaption className="trend-chart__empty-message">{copy.noData}</figcaption>
      </figure>
    );
  }

  const finiteTimes = times.filter(Number.isFinite);
  const firstTime = finiteTimes.length > 0 ? Math.min(...finiteTimes) : 0;
  const lastTime = finiteTimes.length > 0 ? Math.max(...finiteTimes) : pointCount - 1;
  const timeDomainEnd = firstTime === lastTime ? firstTime + 1 : lastTime;
  const [minimumValue, maximumValue] = finiteDomain(
    visibleSeries.map((item) => item.values.slice(0, pointCount)),
    yDomain,
  );
  const resolvedIndex = clampIndex(selectedIndex, pointCount);
  const selectedTime = times[resolvedIndex];

  const xScale = (time: number) =>
    scaleLinear(time, firstTime, timeDomainEnd, PLOT.left, PLOT.right);
  const yScale = (value: number) =>
    scaleLinear(value, minimumValue, maximumValue, PLOT.bottom, PLOT.top);

  const setIndex = (nextIndex: number) => {
    onSelectIndex(clampIndex(nextIndex, pointCount));
  };

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    const keyActions: Partial<Record<string, number>> = {
      ArrowLeft: resolvedIndex - 1,
      ArrowDown: resolvedIndex - 1,
      ArrowRight: resolvedIndex + 1,
      ArrowUp: resolvedIndex + 1,
      PageDown: resolvedIndex - 10,
      PageUp: resolvedIndex + 10,
      Home: 0,
      End: pointCount - 1,
    };
    const nextIndex = keyActions[event.key];
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    setIndex(nextIndex);
  };

  const handleClick = (event: MouseEvent<SVGRectElement>) => {
    const svgBounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    const svgX =
      svgBounds && svgBounds.width > 0
        ? ((event.clientX - svgBounds.left) / svgBounds.width) * CHART_WIDTH
        : event.clientX;
    const boundedX = clamp(svgX, PLOT.left, PLOT.right);

    if (finiteTimes.length === 0) {
      setIndex(nearestIndexForPosition(boundedX, PLOT.left, PLOT.right, pointCount));
      return;
    }

    const targetTime = scaleLinear(
      boundedX,
      PLOT.left,
      PLOT.right,
      firstTime,
      timeDomainEnd,
    );
    setIndex(nearestTimeIndex(times, targetTime));
  };

  const xTicks = Array.from({ length: 6 }, (_, index) => {
    const fraction = index / 5;
    return firstTime + (timeDomainEnd - firstTime) * fraction;
  });
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const fraction = index / 4;
    return minimumValue + (maximumValue - minimumValue) * fraction;
  });
  const selectedX = Number.isFinite(selectedTime) ? xScale(selectedTime) : PLOT.left;
  const selectedTimeLabel = Number.isFinite(selectedTime)
    ? `${formatAxisValue(selectedTime, language)} ${copy.minute}`
    : "—";

  return (
    <figure className={`trend-chart ${className}`.trim()}>
      <svg
        className="trend-chart__svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="group"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <title id={titleId}>{copy.chart}</title>
        <desc id={descriptionId}>{`${copy.selectTime}: ${selectedTimeLabel}`}</desc>
        <defs>
          <clipPath id={clipId}>
            <rect
              x={PLOT.left}
              y={PLOT.top}
              width={PLOT.right - PLOT.left}
              height={PLOT.bottom - PLOT.top}
            />
          </clipPath>
        </defs>

        <g className="trend-chart__stage-bands" clipPath={`url(#${clipId})`}>
          {stageRanges.map((stage, index) => {
            const startX = clamp(xScale(stage.startMinute), PLOT.left, PLOT.right);
            const endX = clamp(xScale(stage.endMinute), PLOT.left, PLOT.right);
            const x = Math.min(startX, endX);
            const width = Math.abs(endX - startX);
            return (
              <rect
                key={stage.id}
                className="trend-chart__stage-band"
                data-stage-id={stage.id}
                x={x}
                y={PLOT.top}
                width={width}
                height={PLOT.bottom - PLOT.top}
                fill={STAGE_COLORS[index % STAGE_COLORS.length]}
                fillOpacity="0.09"
              />
            );
          })}
        </g>

        <g className="trend-chart__grid" aria-hidden="true" fontSize="11">
          {yTicks.map((tick) => {
            const y = yScale(tick);
            return (
              <g key={tick}>
                <line x1={PLOT.left} y1={y} x2={PLOT.right} y2={y} stroke="currentColor" opacity="0.12" />
                <text x={PLOT.left - 10} y={y + 4} textAnchor="end">
                  {formatAxisValue(tick, language)}
                </text>
              </g>
            );
          })}
          {xTicks.map((tick) => {
            const x = xScale(tick);
            return (
              <g key={tick}>
                <line x1={x} y1={PLOT.top} x2={x} y2={PLOT.bottom} stroke="currentColor" opacity="0.08" />
                <text x={x} y={PLOT.bottom + 23} textAnchor="middle">
                  {formatAxisValue(tick, language)}
                </text>
              </g>
            );
          })}
        </g>

        <g className="trend-chart__stage-labels" aria-hidden="true" fontSize="11">
          {stageRanges.map((stage, index) => {
            const startX = clamp(xScale(stage.startMinute), PLOT.left, PLOT.right);
            const endX = clamp(xScale(stage.endMinute), PLOT.left, PLOT.right);
            const stageWidth = Math.abs(endX - startX);
            return (
              <g key={stage.id}>
                {index > 0 && (
                  <line
                    className="trend-chart__stage-boundary"
                    data-stage-boundary={stage.id}
                    x1={startX}
                    y1={PLOT.top}
                    x2={startX}
                    y2={PLOT.bottom}
                    stroke={STAGE_COLORS[index % STAGE_COLORS.length]}
                    strokeWidth="1.5"
                    strokeDasharray="5 5"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {stageWidth >= 45 && (
                  <text
                    x={(startX + endX) / 2}
                    y={PLOT.top - 12}
                    textAnchor="middle"
                    fill={STAGE_COLORS[index % STAGE_COLORS.length]}
                  >
                    {stage.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        <g className="trend-chart__series" clipPath={`url(#${clipId})`}>
          {visibleSeries.map((item, index) => {
            const color = item.color ?? DEFAULT_COLORS[index];
            return (
              <path
                key={item.id}
                className="trend-chart__line"
                data-series-id={item.id}
                d={linePath(times, item.values, xScale, yScale)}
                fill="none"
                stroke={color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              >
                <title>{item.label}</title>
              </path>
            );
          })}
        </g>

        <g className="trend-chart__cursor" aria-hidden="true">
          <line
            x1={selectedX}
            y1={PLOT.top}
            x2={selectedX}
            y2={PLOT.bottom}
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x={clamp(selectedX - 43, PLOT.left, PLOT.right - 86)}
            y={PLOT.bottom + 31}
            width="86"
            height="23"
            rx="11.5"
            fill="currentColor"
          />
          <text
            x={clamp(selectedX, PLOT.left + 43, PLOT.right - 43)}
            y={PLOT.bottom + 47}
            textAnchor="middle"
            fill="white"
            fontSize="10"
          >
            {selectedTimeLabel}
          </text>
          {visibleSeries.map((item, index) => {
            const value = item.values[resolvedIndex];
            if (!Number.isFinite(value)) {
              return null;
            }
            return (
              <circle
                key={item.id}
                cx={selectedX}
                cy={yScale(value)}
                r="4.5"
                fill={item.color ?? DEFAULT_COLORS[index]}
                stroke="white"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>

        <g className="trend-chart__legend" aria-hidden="true" fontSize="12">
          {visibleSeries.map((item, index) => {
            const x = PLOT.left + index * 270;
            const color = item.color ?? DEFAULT_COLORS[index];
            return (
              <g key={item.id} transform={`translate(${x} 20)`}>
                <line x1="0" y1="0" x2="22" y2="0" stroke={color} strokeWidth="3" />
                <text x="29" y="4">
                  {`${item.label}: ${formatSeriesValue(item.values[resolvedIndex], unit, language)}`}
                </text>
              </g>
            );
          })}
        </g>

        <text className="trend-chart__unit-label" x={PLOT.left} y={PLOT.top - 30} fontSize="11">
          {unit || copy.valueAxis}
        </text>
        <text
          className="trend-chart__axis-label"
          x={(PLOT.left + PLOT.right) / 2}
          y={CHART_HEIGHT - 8}
          textAnchor="middle"
          fontSize="12"
        >
          {copy.timeAxis}
        </text>

        <g
          className="trend-chart__interaction"
          data-testid="trend-interaction"
          role="slider"
          tabIndex={0}
          aria-label={copy.selectTime}
          aria-valuemin={firstTime}
          aria-valuemax={lastTime}
          aria-valuenow={Number.isFinite(selectedTime) ? selectedTime : firstTime}
          aria-valuetext={selectedTimeLabel}
          aria-orientation="horizontal"
          onKeyDown={handleKeyDown}
        >
          <rect
            x={PLOT.left}
            y={PLOT.top}
            width={PLOT.right - PLOT.left}
            height={PLOT.bottom - PLOT.top}
            fill="transparent"
            onClick={handleClick}
            style={{ cursor: "crosshair" }}
          />
        </g>
      </svg>
    </figure>
  );
}
