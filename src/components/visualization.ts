import type { MetricDefinition } from "../domain/constants";

export interface ColorStop {
  offset: number;
  color: string;
}

const PALETTES: Record<MetricDefinition["palette"], readonly ColorStop[]> = {
  thermal: [
    { offset: 0, color: "#3156a6" },
    { offset: 0.32, color: "#38a6c7" },
    { offset: 0.58, color: "#f0cf4d" },
    { offset: 0.8, color: "#ed7a3b" },
    { offset: 1, color: "#b9363e" },
  ],
  sequential: [
    { offset: 0, color: "#edf5f3" },
    { offset: 0.35, color: "#8ac7bd" },
    { offset: 0.7, color: "#23858c" },
    { offset: 1, color: "#174b67" },
  ],
  diverging: [
    { offset: 0, color: "#3156a6" },
    { offset: 0.5, color: "#f4f1e8" },
    { offset: 1, color: "#bd3f42" },
  ],
};

const MISSING_COLOR = "#c8ced3";
const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseHex(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

function interpolateColor(start: string, end: string, amount: number): string {
  const startRgb = parseHex(start);
  const endRgb = parseHex(end);
  return `#${startRgb
    .map((channel, index) => toHex(channel + (endRgb[index] - channel) * amount))
    .join("")}`;
}

export function paletteStops(palette: MetricDefinition["palette"]): readonly ColorStop[] {
  return PALETTES[palette];
}

export function colorForMetricValue(
  metric: MetricDefinition,
  value: number | undefined,
  domain: readonly [number, number] = resolveMetricDomain(
    metric,
    [[value ?? Number.NaN]],
  ),
): string {
  if (value === undefined || !Number.isFinite(value)) {
    return MISSING_COLOR;
  }

  const [domainStart, domainEnd] = domain;
  const span = domainEnd - domainStart;
  const normalized = span === 0 ? 0.5 : clamp((value - domainStart) / span, 0, 1);
  const stops = PALETTES[metric.palette];

  const upperIndex = stops.findIndex((stop) => stop.offset >= normalized);
  if (upperIndex <= 0) {
    return stops[0].color;
  }
  if (upperIndex === -1) {
    return stops[stops.length - 1].color;
  }

  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const localAmount = (normalized - lower.offset) / (upper.offset - lower.offset);
  return interpolateColor(lower.color, upper.color, localAmount);
}

export function resolveMetricDomain(
  metric: MetricDefinition,
  valueGroups: readonly (readonly number[])[],
): [number, number] {
  if (metric.domain) {
    return [metric.domain[0], metric.domain[1]];
  }

  const finiteValues = valueGroups.flatMap((values) => values.filter(Number.isFinite));
  const maximum = finiteValues.length > 0 ? Math.max(0, ...finiteValues) : 0;
  if (maximum === 0) {
    return [0, 1];
  }

  const roughStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalizedStep = roughStep / magnitude;
  const stepMultiplier = NICE_STEP_MULTIPLIERS.find((value) => (
    normalizedStep <= value
  )) ?? NICE_STEP_MULTIPLIERS.at(-1)!;
  const niceStep = stepMultiplier * magnitude;

  return [0, Math.ceil(maximum / niceStep) * niceStep];
}

export function formatMetricValue(
  value: number | undefined,
  decimals: number,
  unit = "",
): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const suffix = unit ? ` ${unit}` : "";
  return `${value.toFixed(decimals)}${suffix}`;
}

export function contrastingTextColor(background: string): "#ffffff" | "#17222b" {
  const [red, green, blue] = parseHex(background);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.52 ? "#ffffff" : "#17222b";
}

export function finiteDomain(
  valueGroups: readonly (readonly number[])[],
  requestedDomain?: readonly [number, number],
): [number, number] {
  if (
    requestedDomain &&
    Number.isFinite(requestedDomain[0]) &&
    Number.isFinite(requestedDomain[1]) &&
    requestedDomain[0] !== requestedDomain[1]
  ) {
    return requestedDomain[0] < requestedDomain[1]
      ? [requestedDomain[0], requestedDomain[1]]
      : [requestedDomain[1], requestedDomain[0]];
  }

  const finiteValues = valueGroups.flatMap((values) => values.filter(Number.isFinite));
  if (finiteValues.length === 0) {
    return [0, 1];
  }

  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.05, 1);
    return [minimum - padding, maximum + padding];
  }

  const padding = (maximum - minimum) * 0.08;
  return [minimum - padding, maximum + padding];
}

export function nearestIndexForPosition(
  position: number,
  start: number,
  end: number,
  itemCount: number,
): number {
  if (itemCount <= 1 || end <= start) {
    return 0;
  }
  const normalized = clamp((position - start) / (end - start), 0, 1);
  return Math.round(normalized * (itemCount - 1));
}

export function nearestTimeIndex(times: readonly number[], targetTime: number): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  times.forEach((time, index) => {
    if (!Number.isFinite(time)) {
      return;
    }
    const distance = Math.abs(time - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

export function clampIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return clamp(Math.round(index), 0, itemCount - 1);
}
