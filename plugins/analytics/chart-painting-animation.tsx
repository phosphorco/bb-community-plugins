import { useId } from "react";

export function ChartPaintingAnimation({ className = "" }: { className?: string }) {
  const maskId = `analytics-chart-paint-${useId().replaceAll(":", "")}`;

  return (
    <svg
      className={`analytics-chart-painting ${className}`.trim()}
      viewBox="0 0 240 132"
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="132">
          <rect width="240" height="132" fill="black" />
          <rect x="42" y="76" width="22" height="30" rx="3" fill="white" />
          <rect x="72" y="56" width="22" height="50" rx="3" fill="white" />
          <rect x="102" y="68" width="22" height="38" rx="3" fill="white" />
          <rect x="132" y="38" width="22" height="68" rx="3" fill="white" />
          <rect x="162" y="49" width="22" height="57" rx="3" fill="white" />
          <path
            d="M40 84C58 77 69 82 84 69S110 72 125 57s30-6 42-18 24-4 34-17"
            fill="none"
            stroke="white"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="40" cy="84" r="5" fill="white" />
          <circle cx="84" cy="69" r="5" fill="white" />
          <circle cx="125" cy="57" r="5" fill="white" />
          <circle cx="167" cy="39" r="5" fill="white" />
          <circle cx="201" cy="22" r="5" fill="white" />
        </mask>
      </defs>

      <rect className="analytics-chart-painting__frame" x="1" y="1" width="238" height="130" rx="14" />
      <g className="analytics-chart-painting__grid">
        <path d="M28 27H218M28 53H218M28 79H218M28 105H218" />
        <path d="M28 18V106H218" />
      </g>

      <g mask={`url(#${maskId})`}>
        <path pathLength="1" className="analytics-chart-painting__pass analytics-chart-painting__pass--one" d="M24 32C76 19 152 20 218 30" />
        <path pathLength="1" className="analytics-chart-painting__pass analytics-chart-painting__pass--two" d="M218 64C157 50 83 52 24 65" />
        <path pathLength="1" className="analytics-chart-painting__pass analytics-chart-painting__pass--three" d="M24 98C80 84 153 88 218 96" />
      </g>

      <g className="analytics-chart-painting__outline">
        <rect pathLength="1" x="42" y="76" width="22" height="30" rx="3" />
        <rect pathLength="1" x="72" y="56" width="22" height="50" rx="3" />
        <rect pathLength="1" x="102" y="68" width="22" height="38" rx="3" />
        <rect pathLength="1" x="132" y="38" width="22" height="68" rx="3" />
        <rect pathLength="1" x="162" y="49" width="22" height="57" rx="3" />
        <path pathLength="1" d="M40 84C58 77 69 82 84 69S110 72 125 57s30-6 42-18 24-4 34-17" />
      </g>
      <g className="analytics-chart-painting__points">
        <circle cx="40" cy="84" r="3" />
        <circle cx="84" cy="69" r="3" />
        <circle cx="125" cy="57" r="3" />
        <circle cx="167" cy="39" r="3" />
        <circle cx="201" cy="22" r="3" />
      </g>
    </svg>
  );
}
