"use client";

import { useId, useState } from "react";

/* ===========================================================================
   Charts
   ---------------------------------------------------------------------------
   Deliberately dependency-free SVG. That keeps the bundle small, gives full
   control over the palette (so every chart matches the design system) and
   makes the charts responsive without a charting library's defaults.

   Every chart draws ONLY the data it is given. There is no placeholder
   series: an empty dataset renders an explicit empty state instead of a
   misleading flat line.
   =========================================================================== */

export const CHART_COLORS = {
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
  muted: "var(--muted-2)",
} as const;

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  /** Present so the series can be used on its own; the data lives in the points. */
  values?: number[];
};

export type ChartPoint = { label: string; values: Record<string, number> };

/* ---------------------------------------------------------------------------
   Shared bits
   ------------------------------------------------------------------------- */

function ChartFrame({
  children,
  height = 200,
  ariaLabel,
}: {
  children: React.ReactNode;
  height?: number;
  ariaLabel: string;
}) {
  return (
    <div className="w-full" role="img" aria-label={ariaLabel}>
      <svg
        viewBox={`0 0 720 ${height}`}
        className="h-auto w-full"
        preserveAspectRatio="none"
        style={{ minHeight: 140 }}
      >
        {children}
      </svg>
    </div>
  );
}

function GridLines({ height, rows = 4 }: { height: number; rows?: number }) {
  return (
    <g>
      {Array.from({ length: rows + 1 }, (_, i) => {
        const y = (height / rows) * i;
        return (
          <line
            key={i}
            x1="0"
            x2="720"
            y1={y}
            y2={y}
            stroke="var(--border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

export function ChartLegend({ series }: { series: Array<{ label: string; color: string }> }) {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {series.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------------
   Line / area chart — a trend over time
   ------------------------------------------------------------------------- */

export function LineChart({
  points,
  series,
  height = 220,
  valueSuffix = "",
  ariaLabel,
}: {
  points: ChartPoint[];
  series: ChartSeries[];
  height?: number;
  valueSuffix?: string;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const max = Math.max(1, ...points.flatMap((p) => Object.values(p.values)));
  const count = Math.max(1, points.length - 1);
  const x = (i: number) => (i / count) * 720;
  const y = (v: number) => height - (v / max) * (height - 16) - 8;

  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-[var(--muted)]">
        No data in this period.
      </p>
    );
  }

  return (
    <div className="relative">
      <ChartFrame height={height} ariaLabel={ariaLabel}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        <GridLines height={height} />

        {series.map((s) => {
          const path = points
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.values[s.key] ?? 0).toFixed(1)}`)
            .join(" ");
          const area = `${path} L720,${height} L0,${height} Z`;
          return (
            <g key={s.key}>
              <path d={area} fill={`url(#${gradientId}-${s.key})`} />
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}

        {hover !== null && points[hover] && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1="0"
              y2={height}
              stroke="var(--border-strong)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(points[hover]!.values[s.key] ?? 0)}
                r="4"
                fill="var(--surface)"
                stroke={s.color}
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        )}

        {/* Invisible hit areas for hover/tap. */}
        {points.map((p, i) => (
          <rect
            key={`${p.label}-${i}`}
            x={x(i) - 720 / count / 2}
            y="0"
            width={720 / count}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </ChartFrame>

      {/* X labels: first, middle and last only, so they never collide. */}
      <div className="mt-1 flex justify-between text-[11px] text-[var(--muted)]">
        <span>{points[0]?.label}</span>
        {points.length > 2 && <span>{points[Math.floor(points.length / 2)]?.label}</span>}
        <span>{points[points.length - 1]?.label}</span>
      </div>

      {hover !== null && points[hover] && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px]">
          <span className="font-medium">{points[hover]!.label}</span>
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[var(--muted)]">
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
              <span className="tnum font-medium text-[var(--text)]">
                {points[hover]!.values[s.key] ?? 0}
                {valueSuffix}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Bar chart — a composition per category
   ------------------------------------------------------------------------- */

export function BarChart({
  points,
  series,
  height = 220,
  ariaLabel,
  stacked = true,
}: {
  points: ChartPoint[];
  series: ChartSeries[];
  height?: number;
  ariaLabel: string;
  stacked?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const totals = points.map((p) => Object.values(p.values).reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...(stacked ? totals : points.flatMap((p) => Object.values(p.values))));
  const slot = 720 / Math.max(1, points.length);
  const barWidth = Math.min(46, slot * 0.56);

  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-[var(--muted)]">
        No data in this period.
      </p>
    );
  }

  return (
    <div className="relative">
      <ChartFrame height={height} ariaLabel={ariaLabel}>
        <GridLines height={height} />
        {points.map((p, i) => {
          const cx = slot * i + slot / 2;
          let offset = 0;
          return (
            <g key={`${p.label}-${i}`}>
              {series.map((s) => {
                const v = p.values[s.key] ?? 0;
                const h = (v / max) * (height - 16);
                const y = stacked ? height - offset - h - 8 : height - h - 8;
                offset += h;
                return (
                  <rect
                    key={s.key}
                    x={cx - barWidth / 2}
                    y={y}
                    width={barWidth}
                    height={Math.max(0, h)}
                    rx="3"
                    fill={s.color}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              <rect
                x={slot * i}
                y="0"
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </ChartFrame>

      <div className="mt-1 flex justify-between text-[11px] text-[var(--muted)]">
        <span>{points[0]?.label}</span>
        {points.length > 2 && <span>{points[Math.floor(points.length / 2)]?.label}</span>}
        <span>{points[points.length - 1]?.label}</span>
      </div>

      {hover !== null && points[hover] && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px]">
          <span className="font-medium">{points[hover]!.label}</span>
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[var(--muted)]">
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
              <span className="tnum font-medium text-[var(--text)]">{points[hover]!.values[s.key] ?? 0}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Donut — a single composition
   ------------------------------------------------------------------------- */

export function DonutChart({
  slices,
  size = 168,
  thickness = 22,
  centerLabel,
  centerValue,
  ariaLabel,
}: {
  slices: Array<{ label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: React.ReactNode;
  ariaLabel: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  if (total === 0) {
    return (
      <div
        className="grid place-items-center rounded-full border-[14px] border-[var(--surface-3)] text-[12px] text-[var(--muted)]"
        style={{ width: size, height: size }}
      >
        No data
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
        className="shrink-0 -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={thickness}
        />
        {slices.map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <ul className="flex min-w-0 flex-col gap-1.5 text-[12.5px]">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="text-[var(--muted)]">{s.label}</span>
            <span className="tnum ml-auto font-medium">{s.value}</span>
          </li>
        ))}
      </ul>
      {centerValue !== undefined && (
        <span className="sr-only">
          {centerLabel}: {centerValue}
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Sparkline — a tiny trend inside a tile
   ------------------------------------------------------------------------- */

export function Sparkline({
  values,
  color = "var(--accent)",
  width = 120,
  height = 32,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / range) * (height - 4) - 2;
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <path d={path} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
