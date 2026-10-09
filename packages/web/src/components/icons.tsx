import {
  IconAlertTriangle,
  IconArchive as TablerArchive,
  IconArchiveOff,
  IconArrowBackUp,
  IconArrowDown as TablerArrowDown,
  IconArrowLeft as TablerArrowLeft,
  IconArrowsExchange,
  IconBarbell,
  IconBolt as TablerBolt,
  IconCheck as TablerCheck,
  IconEye as TablerEye,
  IconEyeOff as TablerEyeOff,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCoin,
  IconCopy as TablerCopy,
  IconDatabase as TablerDatabase,
  IconDots,
  IconFile as TablerFile,
  IconFilter as TablerFilter,
  IconFolder as TablerFolder,
  IconHistory as TablerHistory,
  IconKey as TablerKey,
  IconLayoutColumns,
  IconLayoutRows,
  IconLoader2,
  IconMaximize,
  IconMessage,
  IconMessageFilled,
  IconMessageSparkle,
  IconMinimize,
  IconPaperclip as TablerPaperclip,
  IconPencil,
  IconPlayerStopFilled,
  IconPlus as TablerPlus,
  IconQuote as TablerQuote,
  IconRefresh as TablerRefresh,
  IconRestore,
  IconRobotFace,
  IconSearch as TablerSearch,
  IconSettings as TablerSettings,
  IconSettingsAutomation,
  IconShield as TablerShield,
  IconStopwatch as TablerStopwatch,
  IconTerminal2,
  IconTextWrap,
  IconTrash as TablerTrash,
  IconUpload as TablerUpload,
  IconWorld,
  IconX,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType, SVGProps } from "react";
import type { RiskFlag } from "../api/types";

/**
 * Every icon in the app is a thin wrapper around a Tabler glyph
 * (24-unit grid, stroke 2, round caps/joins). Wrappers keep the original
 * contract: 12px by default, and any SVG prop (`width`/`height`, `className`,
 * `style`, `aria-*`) passes straight through to the `<svg>`.
 */

type P = SVGProps<SVGSVGElement>;

const SIZE = 12;

/** Wrap a Tabler component so it takes our `SVGProps` contract and defaults to 12px. */
const wrap = (Glyph: ComponentType<IconProps>) => (p: P) => (
  <Glyph size={SIZE} {...(p as IconProps)} />
);

export const IconKey = wrap(TablerKey);
export const IconDatabase = wrap(TablerDatabase);
export const IconConcurrency = wrap(IconArrowsExchange);
export const IconMoney = wrap(IconCoin);
export const IconExternal = wrap(IconWorld);
export const IconShield = wrap(TablerShield);

export const IconChevron = ({ open, ...p }: P & { open?: boolean }) => (
  <IconChevronRight
    size={SIZE}
    {...(p as IconProps)}
    style={{
      transition: "transform 120ms",
      transform: open ? "rotate(90deg)" : "none",
      ...p.style,
    }}
  />
);

export const IconClose = wrap(IconX);
export const IconArrowLeft = wrap(TablerArrowLeft);
export const IconWarning = wrap(IconAlertTriangle);
export const IconCheck = wrap(TablerCheck);
export const IconEye = wrap(TablerEye);
export const IconEyeOff = wrap(TablerEyeOff);
export const IconRefresh = wrap(TablerRefresh);
export const IconUpload = wrap(TablerUpload);
export const IconPlus = wrap(TablerPlus);
export const IconFile = wrap(TablerFile);
export const IconFolder = wrap(TablerFolder);
export const IconComment = wrap(IconMessage);

/**
 * Solid variant for tiny sizes (the diff-gutter comment bubble renders at
 * 9–10px, where a stroked outline turns to mush).
 */
export const IconCommentFilled = wrap(IconMessageFilled);

/** Stacked rows — unified diff. */
export const IconUnified = wrap(IconLayoutRows);

/** Two columns — side-by-side diff. */
export const IconSplit = wrap(IconLayoutColumns);

/** Text-wrap glyph: a line that turns back on itself. */
export const IconWrap = wrap(IconTextWrap);

/** Gear — opens the settings page. */
export const IconSettings = wrap(TablerSettings);

/** Speech bubble with a spark — the review chat panel. */
export const IconChat = wrap(IconMessageSparkle);

/** Quotation marks — attach something to the chat as a ref. */
export const IconQuote = wrap(TablerQuote);

/** Two stacked sheets — copy to clipboard. */
export const IconCopy = wrap(TablerCopy);

/** Prompt in a window — continue in a terminal. */
export const IconTerminal = wrap(IconTerminal2);

/** Three dots — overflow menu. */
export const IconMore = wrap(IconDots);

/** An open arc that spins — a job in flight. */
export const IconSpinner = ({ className, ...p }: P) => (
  <IconLoader2
    size={SIZE}
    {...(p as IconProps)}
    className={["animate-spin", className].filter(Boolean).join(" ")}
  />
);

/** Stop the reply in flight. */
export const IconStop = wrap(IconPlayerStopFilled);

/** Downward arrow — jump to the latest message. */
export const IconArrowDown = wrap(TablerArrowDown);

export const IconSearch = wrap(TablerSearch);

/** Bare chevron, pointing up or down — used by the search bar's prev/next. */
export const IconCaret = ({ up, ...p }: P & { up?: boolean }) =>
  up ? (
    <IconChevronUp size={SIZE} {...(p as IconProps)} />
  ) : (
    <IconChevronDown size={SIZE} {...(p as IconProps)} />
  );

/** Box with a lid — "put this row away". Struck through to bring it back. */
export const IconArchive = ({ out, ...p }: P & { out?: boolean }) =>
  out ? (
    <IconArchiveOff size={SIZE} {...(p as IconProps)} />
  ) : (
    <TablerArchive size={SIZE} {...(p as IconProps)} />
  );

/** Lightning bolt — the "fast" effort badge. */
export const IconBolt = wrap(TablerBolt);

/** A cog with a play mark — machine output: the generated-files & lockfiles unit. */
export const IconGenerated = wrap(IconSettingsAutomation);

/** A clock with a counter-clockwise arrow — a unit's changelog (history). */
export const IconHistory = wrap(TablerHistory);

/** A stopwatch — how long an analysis run took (its stats popover). */
export const IconStopwatch = wrap(TablerStopwatch);

/** A barbell — the "heavy" effort badge. */
export const IconWeight = wrap(IconBarbell);

/** A bin — delete a message. */
export const IconTrash = wrap(TablerTrash);

/** A paperclip — attach a picture to a comment. */
export const IconPaperclip = wrap(TablerPaperclip);

/** A pencil — edit a sent message. */
export const IconEdit = wrap(IconPencil);

/** A counter-clockwise arrow — rewind the conversation to this point. */
export const IconRewind = wrap(IconRestore);

/** Four outward corner brackets — enter full screen. */
export const IconExpand = wrap(IconMaximize);

/** Four inward corner brackets — exit full screen. */
export const IconCollapse = wrap(IconMinimize);

/** A hooked arrow — reply to a thread. */
export const IconReply = wrap(IconArrowBackUp);

/** A funnel — what a list shows. */
export const IconFilter = wrap(TablerFilter);

/** A small robot head — an AI reviewer. */
export const IconBot = wrap(IconRobotFace);

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
