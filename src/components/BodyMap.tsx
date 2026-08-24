import { useId, useRef, type KeyboardEvent } from "react";

import { SEGMENT_LABELS, type MetricDefinition } from "../domain/constants";
import { BODY_SEGMENTS, type BodySegment, type Language } from "../domain/types";
import {
  colorForMetricValue,
  contrastingTextColor,
  formatMetricValue,
  paletteStops,
  resolveMetricDomain,
} from "./visualization";

export interface BodyMapProps {
  metric: MetricDefinition;
  values: readonly number[];
  unit?: string;
  selectedSegment: BodySegment;
  language: Language;
  onSelectSegment: (segment: BodySegment) => void;
  domain?: readonly [number, number];
  className?: string;
}

interface Annotation {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  internal?: boolean;
  point?: readonly [number, number];
}

interface RegionPath {
  d: string;
  transform?: string;
}

interface SegmentGeometry {
  paths: readonly RegionPath[];
  annotation: Annotation;
}

const FRONT_TO_BACK_TRANSFORM = "matrix(-1 0 0 1 935 0)";
const TORSO_PATH = "M237 124 C247 116 257 115 270 126 C283 115 293 116 303 124 L305 202 C293 214 247 214 235 202 Z";

function frontAndBack(d: string): readonly RegionPath[] {
  return [{ d }, { d, transform: FRONT_TO_BACK_TRANSFORM }];
}

function frontOnly(d: string): readonly RegionPath[] {
  return [{ d }];
}

function backOnly(d: string): readonly RegionPath[] {
  return [{ d, transform: FRONT_TO_BACK_TRANSFORM }];
}

const SEGMENT_GEOMETRY: Record<BodySegment, SegmentGeometry> = {
  Head: {
    paths: frontAndBack("M246 66 C246 42 256 28 270 28 C284 28 294 42 294 66 C294 93 284 106 270 106 C256 106 246 93 246 66 Z"),
    annotation: { x: 270, y: 58, anchor: "middle", internal: true },
  },
  Neck: {
    paths: frontAndBack("M258 103 L282 103 L286 125 L254 125 Z"),
    annotation: { x: 356, y: 88, anchor: "start", point: [282, 111] },
  },
  Chest: {
    paths: frontOnly(TORSO_PATH),
    annotation: { x: 270, y: 153, anchor: "middle", internal: true },
  },
  Back: {
    paths: backOnly(TORSO_PATH),
    annotation: { x: 665, y: 153, anchor: "middle", internal: true },
  },
  Pelvis: {
    paths: frontAndBack("M235 204 C247 211 293 211 305 204 L302 259 C292 273 248 273 238 259 Z"),
    annotation: { x: 270, y: 230, anchor: "middle", internal: true },
  },
  LShoulder: {
    paths: frontAndBack("M301 122 C314 120 327 126 334 138 L328 164 L304 157 Z"),
    annotation: { x: 386, y: 128, anchor: "start", point: [322, 141] },
  },
  LArm: {
    paths: frontAndBack("M327 157 L346 162 L354 258 L334 262 L319 164 Z"),
    annotation: { x: 386, y: 207, anchor: "start", point: [343, 210] },
  },
  LHand: {
    paths: frontAndBack("M334 258 L354 255 L361 300 L353 323 L337 313 Z"),
    annotation: { x: 386, y: 290, anchor: "start", point: [352, 288] },
  },
  RShoulder: {
    paths: frontAndBack("M239 122 C226 120 213 126 206 138 L212 164 L236 157 Z"),
    annotation: { x: 154, y: 128, anchor: "end", point: [218, 141] },
  },
  RArm: {
    paths: frontAndBack("M213 157 L194 162 L186 258 L206 262 L221 164 Z"),
    annotation: { x: 154, y: 207, anchor: "end", point: [197, 210] },
  },
  RHand: {
    paths: frontAndBack("M206 258 L186 255 L179 300 L187 323 L203 313 Z"),
    annotation: { x: 154, y: 290, anchor: "end", point: [188, 288] },
  },
  LThigh: {
    paths: frontAndBack("M270 265 L300 260 L306 368 L278 376 L268 286 Z"),
    annotation: { x: 386, y: 344, anchor: "start", point: [293, 326] },
  },
  LLeg: {
    paths: frontAndBack("M278 372 L306 365 L303 474 L282 482 L274 441 Z"),
    annotation: { x: 386, y: 425, anchor: "start", point: [293, 426] },
  },
  LFoot: {
    paths: frontAndBack("M282 478 L303 471 L322 500 L318 516 L278 516 L274 501 Z"),
    annotation: { x: 386, y: 501, anchor: "start", point: [300, 501] },
  },
  RThigh: {
    paths: frontAndBack("M270 265 L240 260 L234 368 L262 376 L272 286 Z"),
    annotation: { x: 154, y: 344, anchor: "end", point: [247, 326] },
  },
  RLeg: {
    paths: frontAndBack("M262 372 L234 365 L237 474 L258 482 L266 441 Z"),
    annotation: { x: 154, y: 425, anchor: "end", point: [247, 426] },
  },
  RFoot: {
    paths: frontAndBack("M258 478 L237 471 L218 500 L222 516 L262 516 L266 501 Z"),
    annotation: { x: 154, y: 501, anchor: "end", point: [240, 501] },
  },
};

const COPY = {
  zh: {
    front: "正面",
    back: "背面",
    legend: "数值色标",
    diagram: "人体局部分布图",
    select: "选择人体部位",
    swipe: "左右滑动查看正面和背面",
  },
  en: {
    front: "Front",
    back: "Back",
    legend: "Value scale",
    diagram: "Regional body map",
    select: "Select body region",
    swipe: "Swipe to inspect the front and back views",
  },
} as const;

function legendValue(value: number, metric: MetricDefinition, unit: string): string {
  return formatMetricValue(value, metric.decimals, unit);
}

export function BodyMap({
  metric,
  values,
  unit = "",
  selectedSegment,
  language,
  onSelectSegment,
  domain,
  className = "",
}: BodyMapProps) {
  const titleId = useId();
  const descriptionId = useId();
  const gradientId = `${useId().replaceAll(":", "")}-body-map-gradient`;
  const segmentRefs = useRef<Partial<Record<BodySegment, SVGGElement | null>>>({});
  const copy = COPY[language];
  const resolvedDomain = domain ?? resolveMetricDomain(metric, [values]);

  const moveSelection = (current: BodySegment, offset: number) => {
    const currentIndex = BODY_SEGMENTS.indexOf(current);
    const targetIndex = (currentIndex + offset + BODY_SEGMENTS.length) % BODY_SEGMENTS.length;
    const target = BODY_SEGMENTS[targetIndex];
    onSelectSegment(target);
    segmentRefs.current[target]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>, segment: BodySegment) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectSegment(segment);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(segment, 1);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(segment, -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? BODY_SEGMENTS[0] : BODY_SEGMENTS.at(-1)!;
      onSelectSegment(target);
      segmentRefs.current[target]?.focus();
    }
  };

  return (
    <figure className={`body-map ${className}`.trim()}>
      <figcaption className="body-map__caption">
        <span>{metric.label[language]}</span>
        <span className="body-map__metric-code">{metric.shortLabel}</span>
      </figcaption>
      <span className="body-map__mobile-hint">{copy.swipe}</span>
      <svg
        className="body-map__svg"
        viewBox="0 0 900 580"
        role="group"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <title id={titleId}>{`${copy.diagram}: ${metric.label[language]}`}</title>
        <desc id={descriptionId}>{copy.select}</desc>
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            {paletteStops(metric.palette).map((stop) => (
              <stop key={stop.offset} offset={`${stop.offset * 100}%`} stopColor={stop.color} />
            ))}
          </linearGradient>
        </defs>

        <text className="body-map__view-label" x="270" y="20" textAnchor="middle" fontSize="13">
          {copy.front}
        </text>
        <text className="body-map__view-label" x="665" y="20" textAnchor="middle" fontSize="13">
          {copy.back}
        </text>

        {BODY_SEGMENTS.map((segment, index) => {
          const geometry = SEGMENT_GEOMETRY[segment];
          const value = values[index];
          const fill = colorForMetricValue(metric, value, resolvedDomain);
          const displayValue = formatMetricValue(value, metric.decimals, unit);
          const label = SEGMENT_LABELS[segment][language];
          const selected = segment === selectedSegment;
          const textColor = geometry.annotation.internal
            ? contrastingTextColor(fill)
            : "currentColor";

          return (
            <g
              key={segment}
              ref={(element) => {
                segmentRefs.current[segment] = element;
              }}
              className={`body-map__segment${selected ? " body-map__segment--selected" : ""}`}
              data-segment={segment}
              data-selected={selected ? "true" : "false"}
              role="button"
              tabIndex={selected ? 0 : -1}
              aria-pressed={selected}
              aria-label={`${label}: ${displayValue}`}
              onClick={() => onSelectSegment(segment)}
              onKeyDown={(event) => handleKeyDown(event, segment)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${label}: ${displayValue}`}</title>
              {geometry.paths.map((path, pathIndex) => (
                <path
                  key={`${pathIndex}-${path.transform ?? "front"}`}
                  className="body-map__region"
                  d={path.d}
                  transform={path.transform}
                  fill={fill}
                  stroke={selected ? "#111827" : "#ffffff"}
                  strokeWidth={selected ? 4 : 2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  data-copy-index={pathIndex}
                />
              ))}
              {geometry.annotation.point && (
                <line
                  className="body-map__callout"
                  x1={geometry.annotation.point[0]}
                  y1={geometry.annotation.point[1]}
                  x2={
                    geometry.annotation.x +
                    (geometry.annotation.anchor === "start" ? -7 : 7)
                  }
                  y2={geometry.annotation.y - 4}
                  stroke={selected ? "#111827" : "currentColor"}
                  strokeWidth={selected ? 2 : 1}
                  opacity="0.65"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <text
                className="body-map__annotation"
                x={geometry.annotation.x}
                y={geometry.annotation.y}
                textAnchor={geometry.annotation.anchor}
                fill={textColor}
                pointerEvents="none"
                fontSize="10"
              >
                <tspan className="body-map__annotation-label" x={geometry.annotation.x}>
                  {label}
                </tspan>
                <tspan
                  className="body-map__annotation-value"
                  x={geometry.annotation.x}
                  dy="15"
                  fontWeight="700"
                  fontSize="12"
                >
                  {displayValue}
                </tspan>
              </text>
            </g>
          );
        })}

        <g className="body-map__legend" aria-label={copy.legend} fontSize="11">
          <rect x="185" y="538" width="530" height="14" rx="7" fill={`url(#${gradientId})`} />
          <text x="185" y="570" textAnchor="start">
            {legendValue(resolvedDomain[0], metric, unit)}
          </text>
          <text x="450" y="570" textAnchor="middle">
            {legendValue((resolvedDomain[0] + resolvedDomain[1]) / 2, metric, unit)}
          </text>
          <text x="715" y="570" textAnchor="end">
            {legendValue(resolvedDomain[1], metric, unit)}
          </text>
        </g>
      </svg>
    </figure>
  );
}
