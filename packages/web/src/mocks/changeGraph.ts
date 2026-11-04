/**
 * The change map and blast radius of the mock PR (billing #482), as the
 * server's heuristic extraction would answer them: the functions its hunks
 * touch, the calls among them, and callers outside the diff.
 */
import type { BlastRadius, ChangeMap, ChangeMapNode } from "../api/types";

const SHA = "9f2c1e7a4b3d5f60718293a4b5c6d7e8f9012345";

const node = (
  path: string,
  name: string,
  line: number,
  status: ChangeMapNode["status"],
  lines: number,
  unit: string | undefined,
  extra: Partial<ChangeMapNode> = {},
): ChangeMapNode => ({
  id: `${path}#${extra.qualifier ? `${extra.qualifier}.` : ""}${name}@${line}`,
  name,
  path,
  line,
  status,
  lines,
  ...(unit ? { unit } : {}),
  ...extra,
});

const nodes: ChangeMapNode[] = [
  node("src/billing/charge.ts", "charge", 18, "changed", 17, "idempotent-charge-path", { qualifier: "ChargeService" }),
  node("src/billing/charge.ts", "retry", 68, "added", 13, "transient-retry-backoff", { qualifier: "ChargeService" }),
  node("src/billing/charge.ts", "isTransient", 84, "added", 6, "transient-retry-backoff"),
  node("src/billing/idempotency.ts", "idempotencyKey", 4, "added", 10, "idempotent-charge-path"),
  node("src/billing/ledger.ts", "findByKey", 6, "added", 7, "idempotent-charge-path", { qualifier: "ChargeLedger" }),
  node("src/billing/ledger.ts", "record", 14, "added", 6, "idempotent-charge-path", { qualifier: "ChargeLedger" }),
  node("src/billing/ledger.ts", "recordFailure", 21, "added", 6, "idempotent-charge-path", { qualifier: "ChargeLedger" }),
  node("src/billing/reconcile.ts", "verdictFor", 14, "added", 9, "ledger-reconciliation"),
  node("src/billing/reconcile.ts", "run", 64, "changed", 22, "ledger-reconciliation", { qualifier: "Reconciler" }),
  node("src/billing/reconcile.ts", "add", 118, "added", 3, "ledger-reconciliation", { qualifier: "ReconcileReport" }),
  node("src/billing/reconcile.ts", "addGatewayOnly", 122, "added", 3, "ledger-reconciliation", { qualifier: "ReconcileReport" }),
  node("src/billing/reconcile.ts", "mismatches", 126, "added", 3, "ledger-reconciliation", { qualifier: "ReconcileReport" }),
  node("src/billing/reconcile.ts", "buildReconciler", 176, "changed", 2, "ledger-reconciliation"),
  node("src/billing/report.ts", "formatMismatch", 1, "added", 4, "report-module", { movedFrom: "src/billing/reconcileReport.ts" }),
  node("src/billing/report.ts", "formatReport", 6, "added", 5, "report-module", { movedFrom: "src/billing/reconcileReport.ts" }),
  node("src/container.ts", "buildContainer", 12, "changed", 2, "wiring-and-docs"),
  node("src/jobs/reconcileNightly.ts", "describe", 23, "changed", 11, "ledger-reconciliation"),
];

const id = (path: string, name: string) => nodes.find((n) => n.path === path && n.name === name)!.id;
const edge = (from: [string, string], to: [string, string], calls = 1) => ({ from: id(...from), to: id(...to), calls });
const CHARGE = "src/billing/charge.ts";
const LEDGER = "src/billing/ledger.ts";
const RECONCILE = "src/billing/reconcile.ts";

export const mockChangeMap: ChangeMap = {
  available: true,
  sha: SHA,
  nodes,
  edges: [
    edge([CHARGE, "charge"], ["src/billing/idempotency.ts", "idempotencyKey"]),
    edge([CHARGE, "charge"], [LEDGER, "findByKey"]),
    edge([CHARGE, "charge"], [CHARGE, "retry"]),
    edge([CHARGE, "charge"], [LEDGER, "recordFailure"]),
    edge([CHARGE, "charge"], [LEDGER, "record"]),
    edge([CHARGE, "retry"], [CHARGE, "isTransient"]),
    edge([RECONCILE, "run"], [RECONCILE, "verdictFor"]),
    edge([RECONCILE, "run"], [RECONCILE, "add"]),
    edge([RECONCILE, "run"], [RECONCILE, "addGatewayOnly"]),
    edge(["src/billing/report.ts", "formatReport"], ["src/billing/report.ts", "formatMismatch"]),
  ],
  total: nodes.length,
  unsupportedFiles: 2,
  unreadFiles: 0,
};

const gh = (path: string, line: number) => `https://github.com/acme/billing/blob/${SHA}/${path}#L${line}`;

export const mockBlastRadius: BlastRadius = {
  available: true,
  sha: SHA,
  functions: [
    {
      id: id(CHARGE, "charge"),
      name: "charge",
      qualifier: "ChargeService",
      path: CHARGE,
      line: 18,
      unit: "idempotent-charge-path",
      total: 3,
      sites: [
        {
          path: "src/api/routes/subscriptions.ts",
          line: 88,
          text: "const charge = await chargeService.charge(sub.nextOrder());",
          enclosing: "renewSubscription",
          url: gh("src/api/routes/subscriptions.ts", 88),
        },
        {
          path: "src/jobs/retryFailedCharges.ts",
          line: 31,
          text: "await chargeService.charge(order);",
          enclosing: "retryFailed",
          url: gh("src/jobs/retryFailedCharges.ts", 31),
        },
        {
          path: "test/billing/charge.test.ts",
          line: 22,
          text: "const res = await service.charge(order);",
          url: gh("test/billing/charge.test.ts", 22),
        },
      ],
    },
    {
      id: id(RECONCILE, "buildReconciler"),
      name: "buildReconciler",
      path: RECONCILE,
      line: 176,
      unit: "ledger-reconciliation",
      total: 1,
      sites: [
        {
          path: "scripts/backfillReconcile.ts",
          line: 12,
          text: "const reconciler = buildReconciler(pool);",
          enclosing: "main",
          url: gh("scripts/backfillReconcile.ts", 12),
        },
      ],
    },
    {
      id: id("src/container.ts", "buildContainer"),
      name: "buildContainer",
      path: "src/container.ts",
      line: 12,
      unit: "wiring-and-docs",
      total: 1,
      sites: [
        {
          path: "src/server.ts",
          line: 8,
          text: "export const container = buildContainer(pool);",
          url: gh("src/server.ts", 8),
        },
      ],
    },
  ],
  skipped: [{ name: "run", reason: "too short" }],
  uncalled: 1,
  notSearched: 0,
  tests: 0,
};
