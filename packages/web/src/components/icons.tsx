import type { SVGProps } from "react";
import type { RiskFlag } from "../api/types";

const base = {
  width: 12,
  height: 12,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type P = SVGProps<SVGSVGElement>;

export const IconKey = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="M7.3 8.7 13 3M11 5l1.5 1.5M9.5 6.5 11 8" />
  </svg>
);

export const IconDatabase = (p: P) => (
  <svg {...base} {...p}>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </svg>
);

export const IconConcurrency = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2 5h9l-2-2M14 11H5l2 2" />
  </svg>
);

export const IconMoney = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5v7M10 6.2C9.4 5.6 8.8 5.4 8 5.4c-1 0-1.8.5-1.8 1.3S7 8 8 8.2s1.9.5 1.9 1.4-.8 1.4-1.9 1.4c-.9 0-1.5-.3-2-.9" />
  </svg>
);

export const IconExternal = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2C6.2 4 6.2 12 8 14" />
  </svg>
);

export const IconShield = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8 1.8 13 3.5v4.2c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V3.5z" />
  </svg>
);

export const IconChevron = ({ open, ...p }: P & { open?: boolean }) => (
  <svg
    {...base}
    {...p}
    style={{
      transition: "transform 120ms",
      transform: open ? "rotate(90deg)" : "none",
      ...p.style,
    }}
  >
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base} {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13.5 2v3.5H10" />
  </svg>
);

export const IconUpload = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 11v2.5h11V11" />
  </svg>
);

export const IconFile = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10A1.5 1.5 0 0 0 4.5 14.5h7A1.5 1.5 0 0 0 13 13V5.5z" />
    <path d="M9 1.5V5.5H13" />
  </svg>
);

export const IconFolder = (p: P) => (
  <svg {...base} {...p}>
    <path d="M1.8 12.5v-9h4.4l1.4 1.8h6.6v7.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
  </svg>
);

export const IconComment = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14 9.5A1.5 1.5 0 0 1 12.5 11H6l-3 2.5V4A1.5 1.5 0 0 1 4.5 2.5h8A1.5 1.5 0 0 1 14 4z" />
  </svg>
);

/** Stacked rows — unified diff. */
export const IconUnified = (p: P) => (
  <svg {...base} {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12M2 10h12" />
  </svg>
);

/** Two columns — side-by-side diff. */
export const IconSplit = (p: P) => (
  <svg {...base} {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M8 2.5v11" />
  </svg>
);

export const RISK_META: Record<
  RiskFlag,
  { icon: (p: P) => JSX.Element; label: string }
> = {
  auth: { icon: IconKey, label: "auth" },
  migration: { icon: IconDatabase, label: "migration" },
  concurrency: { icon: IconConcurrency, label: "concurrency" },
  money: { icon: IconMoney, label: "money" },
  "external-call": { icon: IconExternal, label: "external call" },
  security: { icon: IconShield, label: "security" },
};
