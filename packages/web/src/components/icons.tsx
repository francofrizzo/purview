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

/** Text-wrap glyph: a line that turns back on itself. */
export const IconWrap = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2 3.5h12" />
    <path d="M2 8h9a2.25 2.25 0 0 1 0 4.5H6" />
    <path d="M8 10.5 6 12.75l2 2.25" />
  </svg>
);

/** Gear — opens the settings page. */
export const IconSettings = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="2.25" />
    <path d="M12.9 9.6a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.89 1.89l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 1 1-2.67 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.89-1.89l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 1 1 0-2.67h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.89-1.89l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 1 1 2.67 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.89 1.89l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 1 1 0 2.67h-.06a1.1 1.1 0 0 0-1 .67z" />
  </svg>
);

/** Speech bubble with a spark — the Claude chat panel. */
export const IconChat = (p: P) => (
  <svg {...base} {...p}>
    <path d="M13.5 9.2A1.6 1.6 0 0 1 11.9 10.8H5.6L2.5 13.2V3.9A1.6 1.6 0 0 1 4.1 2.3h7.8a1.6 1.6 0 0 1 1.6 1.6z" />
    <path d="M8 4.6 8.7 6.3 10.4 7 8.7 7.7 8 9.4 7.3 7.7 5.6 7 7.3 6.3z" />
  </svg>
);

/** Quotation marks — attach something to the chat as a ref. */
export const IconQuote = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 4.5C4.3 5.2 3.2 6.6 3.2 8.3v3.2h3.4V8.3H4.9c0-1 .5-1.9 1.6-2.4zM13 4.5c-1.7.7-2.8 2.1-2.8 3.8v3.2h3.4V8.3h-1.7c0-1 .5-1.9 1.6-2.4z" />
  </svg>
);

/** Two stacked sheets — copy to clipboard. */
export const IconCopy = (p: P) => (
  <svg {...base} {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
    <path d="M10.5 3.2A1.2 1.2 0 0 0 9.3 2.5H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6c0 .5.3.9.7 1.1" />
  </svg>
);

/** Three dots — overflow menu. */
export const IconMore = (p: P) => (
  <svg {...base} {...p} strokeWidth={0} fill="currentColor">
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);

/** An open arc that spins — a job in flight. */
export const IconSpinner = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8 2a6 6 0 1 1-4.2 1.75" opacity={0.85}>
      <animateTransform
        attributeName="transform"
        type="rotate"
        from="0 8 8"
        to="360 8 8"
        dur="0.9s"
        repeatCount="indefinite"
      />
    </path>
  </svg>
);

/** Downward arrow in a circle — jump to the latest message. */
export const IconArrowDown = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.3 3.3" />
  </svg>
);

/** Bare chevron, pointing up or down — used by the search bar's prev/next. */
export const IconCaret = ({ up, ...p }: P & { up?: boolean }) => (
  <svg {...base} {...p}>
    <path d={up ? "M4 10 8 6l4 4" : "M4 6l4 4 4-4"} />
  </svg>
);

/** Box with a lid — "put this row away". Mirrored (arrow up) to bring it back. */
export const IconArchive = ({ out, ...p }: P & { out?: boolean }) => (
  <svg {...base} {...p}>
    <rect x="2" y="2.5" width="12" height="3" rx="0.8" />
    <path d="M3 5.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7" />
    <path d={out ? "M8 11.5V7.5M6.2 9.3 8 7.5l1.8 1.8" : "M8 7.5v4M6.2 9.7 8 11.5l1.8-1.8"} />
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
