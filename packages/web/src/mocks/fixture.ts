import type {
  ConfigSource,
  ResolvedAgent,
  DraftComment,
  FilesJson,
  Hunk,
  PrDetail,
  PrListEntry,
  PrState,
  RepoConfig,
  RemoteComment,
  RemoteConversationComment,
  RemoteReview,
  RemoteThread,
  RepoSummary,
  ReviewUnit,
} from "../api/types";
import { buildGeneratedUnit } from "./generated";

const meta = {
  host: "github.com",
  owner: "acme",
  repo: "billing",
  number: 482,
  url: "https://github.com/acme/billing/pull/482",
  title: "Charge retries: idempotency keys + backoff",
  author: "dana",
  body: [
    "<!-- Template: describe the change, link the ticket, list how you tested it. -->",
    "## What",
    "",
    "Retried charges could double-bill when the gateway timed out *after* capturing. This makes",
    "`charge()` idempotent: every attempt derives a key from the order, and a ledger row records",
    "the outcome so a replay returns it instead of charging again.",
    "",
    "## How",
    "",
    "- `idempotencyKey(orderId, total, currency)` feeds the gateway's own idempotency header",
    "- new `charge_ledger` table (migration `0042`), written on success **and** failure",
    "- `retry()` wraps the gateway call with jittered exponential backoff (max 4 attempts)",
    "",
    "No behavior change for first-time charges.",
    "",
    "- [x] Backend",
    "- [ ] Frontend",
    "",
    "> [!WARNING]",
    "> Run migration `0042` before deploying; ~~no flag~~ there is no feature flag.",
    "",
    "<details>",
    "<summary>🤖 Agent notes</summary>",
    "",
    "The key excludes timestamps on purpose. Tested with <kbd>make</kbd> `test-billing`.",
    "",
    "</details>",
    "",
    "Closes BILL-1187.",
  ].join("\n"),
  createdAt: "2026-08-09T10:12:00Z",
  headRef: "dana/charge-retries-idempotency",
  // Stacked on #491 (tracked below), so the header's "stacked on" chip shows.
  baseRef: "dana/ledger-writer-split",
  basePr: {
    number: 491,
    title: "WIP: split the ledger writer out of ChargeService",
    url: "https://github.com/acme/billing/pull/491",
  },
};

export const MOCK_KEY = "github.com/acme/billing/482";

function h(
  id: string,
  file: string,
  header: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: string[],
): Hunk {
  return { id, file, header, oldStart, oldLines, newStart, newLines, lines };
}

const hunks: Hunk[] = [
  h(
    "a1b2c3d4e5f60001",
    "src/billing/charge.ts",
    "@@ -18,10 +18,26 @@ export class ChargeService {",
    18,
    10,
    18,
    26,
    [
      "   private readonly gateway: Gateway;",
      " ",
      "   async charge(order: Order): Promise<ChargeResult> {",
      "-    const res = await this.gateway.charge(order.total, order.currency);",
      "-    if (!res.ok) throw new ChargeFailed(res.code);",
      "-    return { id: res.id, status: \"captured\" };",
      "+    const key = idempotencyKey(order.id, order.total, order.currency);",
      "+    const existing = await this.ledger.findByKey(key);",
      "+    if (existing) return existing.result;",
      "+",
      "+    const res = await this.retry(() =>",
      "+      this.gateway.charge(order.total, order.currency, { idempotencyKey: key }),",
      "+    );",
      "+    if (!res.ok) {",
      "+      await this.ledger.recordFailure(key, res.code);",
      "+      throw new ChargeFailed(res.code);",
      "+    }",
      "+    const result = { id: res.id, status: \"captured\" as const };",
      "+    await this.ledger.record(key, result);",
      "+    return result;",
      "   }",
      " ",
      "   async refund(chargeId: string): Promise<void> {",
    ],
  ),
  h(
    "a1b2c3d4e5f60002",
    "src/billing/charge.ts",
    "@@ -52,6 +68,24 @@ export class ChargeService {",
    52,
    6,
    68,
    24,
    [
      "     await this.gateway.refund(chargeId);",
      "   }",
      " ",
      "+  private async retry<T>(fn: () => Promise<T>): Promise<T> {",
      "+    let delay = 200;",
      "+    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {",
      "+      try {",
      "+        return await fn();",
      "+      } catch (err) {",
      "+        if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;",
      "+        await sleep(delay + Math.random() * delay);",
      "+        delay *= 2;",
      "+      }",
      "+    }",
      "+    throw new Error(\"unreachable\");",
      "+  }",
      "+",
      " }",
    ],
  ),
  h(
    "a1b2c3d4e5f60003",
    "src/billing/idempotency.ts",
    "@@ -0,0 +1,14 @@",
    0,
    0,
    1,
    14,
    [
      "+import { createHash } from \"node:crypto\";",
      "+",
      "+/** Stable key for a charge attempt. Must not include timestamps. */",
      "+export function idempotencyKey(",
      "+  orderId: string,",
      "+  amount: number,",
      "+  currency: string,",
      "+): string {",
      "+  return createHash(\"sha256\")",
      "+    .update(`${orderId}:${amount}:${currency}`)",
      "+    .digest(\"hex\")",
      "+    .slice(0, 32);",
      "+}",
      "+",
    ],
  ),
  h(
    "a1b2c3d4e5f60004",
    "migrations/0042_charge_ledger.sql",
    "@@ -0,0 +1,11 @@",
    0,
    0,
    1,
    11,
    [
      "+CREATE TABLE charge_ledger (",
      "+  key         TEXT PRIMARY KEY,",
      "+  order_id    TEXT NOT NULL,",
      "+  result      JSONB,",
      "+  failure     TEXT,",
      "+  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()",
      "+);",
      "+",
      "+CREATE INDEX charge_ledger_order_id_idx ON charge_ledger (order_id);",
      "+",
    ],
  ),
  h(
    "a1b2c3d4e5f60005",
    "src/billing/ledger.ts",
    "@@ -1,4 +1,32 @@",
    1,
    4,
    1,
    32,
    [
      " import type { Pool } from \"pg\";",
      "+import type { ChargeResult } from \"./types\";",
      "+",
      "+export class ChargeLedger {",
      "+  constructor(private readonly pool: Pool) {}",
      "+",
      "+  async findByKey(key: string) {",
      "+    const { rows } = await this.pool.query(",
      "+      \"SELECT result FROM charge_ledger WHERE key = $1\",",
      "+      [key],",
      "+    );",
      "+    return rows[0] ? { result: rows[0].result as ChargeResult } : null;",
      "+  }",
      "+",
      "+  async record(key: string, result: ChargeResult) {",
      "+    await this.pool.query(",
      "+      \"INSERT INTO charge_ledger (key, result) VALUES ($1, $2) ON CONFLICT DO NOTHING\",",
      "+      [key, result],",
      "+    );",
      "+  }",
      "+}",
      " ",
    ],
  ),
  h(
    "a1b2c3d4e5f60006",
    "src/container.ts",
    "@@ -12,6 +12,8 @@ export function buildContainer(pool: Pool) {",
    12,
    6,
    12,
    8,
    [
      "   const gateway = new StripeGateway(env.STRIPE_KEY);",
      "+  const ledger = new ChargeLedger(pool);",
      "   const charge = new ChargeService(gateway, ledger);",
      " ",
      "   return { gateway, charge };",
      " }",
    ],
  ),
  h(
    "a1b2c3d4e5f60007",
    "src/api/routes/orders.ts",
    "@@ -44,7 +44,7 @@ router.post(\"/orders/:id/pay\", async (req, res) => {",
    44,
    7,
    44,
    7,
    [
      "   const order = await orders.get(req.params.id);",
      "-  const charge = await chargeService.charge(order);",
      "+  const charge = await chargeService.charge(order, { requestId: req.id });",
      "   res.json({ charge });",
      " });",
    ],
  ),
  h(
    "a1b2c3d4e5f60008",
    "test/billing/charge.test.ts",
    "@@ -30,6 +30,28 @@ describe(\"ChargeService\", () => {",
    30,
    6,
    30,
    28,
    [
      "     expect(res.status).toBe(\"captured\");",
      "   });",
      " ",
      "+  it(\"is idempotent for the same order+amount\", async () => {",
      "+    const first = await service.charge(order);",
      "+    const second = await service.charge(order);",
      "+    expect(second.id).toBe(first.id);",
      "+    expect(gateway.calls).toHaveLength(1);",
      "+  });",
      "+",
      "+  it(\"retries transient gateway errors with backoff\", async () => {",
      "+    gateway.failNext(2, { transient: true });",
      "+    const res = await service.charge(order);",
      "+    expect(res.status).toBe(\"captured\");",
      "+    expect(gateway.calls).toHaveLength(3);",
      "+  });",
      "+",
      " });",
    ],
  ),
  h(
    "a1b2c3d4e5f60009",
    "docs/billing.md",
    "@@ -8,3 +8,9 @@ Charges go through the gateway adapter.",
    8,
    3,
    8,
    9,
    [
      " Charges go through the gateway adapter.",
      " ",
      "+## Idempotency",
      "+",
      "+Every charge attempt derives a key from `(orderId, amount, currency)`.",
      "+Replays return the recorded result instead of hitting the gateway.",
      "+",
    ],
  ),
  // Generated files and a lockfile, one per detection signal the file tree
  // tags: a lockfile name, a generated-code path, and .gitattributes.
  h(
    "a1b2c3d4e5f6000a",
    "pnpm-lock.yaml",
    "@@ -1204,6 +1204,14 @@ packages:",
    1204,
    6,
    1204,
    14,
    [
      "   /@acme/gateway-client@4.1.0:",
      "     resolution: {integrity: sha512-9cQ0bWq1…}",
      "+  /@acme/ledger@0.3.2:",
      "+    resolution: {integrity: sha512-Lr3ZcY0p…}",
      "+    dependencies:",
      "+      '@acme/db': 2.8.1",
      "+    dev: false",
      "+",
      "+  /p-retry@6.2.0:",
      "+    resolution: {integrity: sha512-JA6nkq6h…}",
      "   /@acme/db@2.8.1:",
      "     resolution: {integrity: sha512-u8yHnD3k…}",
      " ",
    ],
  ),
  h(
    "a1b2c3d4e5f6000b",
    "gen/proto/billing/v1/charge.pb.go",
    "@@ -0,0 +1,12 @@",
    0,
    0,
    1,
    12,
    [
      "+// Code generated by protoc-gen-go. DO NOT EDIT.",
      "+// source: billing/v1/charge.proto",
      "+",
      "+package billingv1",
      "+",
      "+type ChargeRequest struct {",
      "+\tOrderId        string `protobuf:\"bytes,1,opt,name=order_id,json=orderId,proto3\" json:\"order_id,omitempty\"`",
      "+\tAmount         int64  `protobuf:\"varint,2,opt,name=amount,proto3\" json:\"amount,omitempty\"`",
      "+\tCurrency       string `protobuf:\"bytes,3,opt,name=currency,proto3\" json:\"currency,omitempty\"`",
      "+\tIdempotencyKey string `protobuf:\"bytes,4,opt,name=idempotency_key,json=idempotencyKey,proto3\" json:\"idempotency_key,omitempty\"`",
      "+}",
      "+",
    ],
  ),
  h(
    "a1b2c3d4e5f6000c",
    "src/api/openapi.d.ts",
    "@@ -88,6 +88,10 @@ export interface components {",
    88,
    6,
    88,
    10,
    [
      "     ChargeResult: {",
      "       id: string;",
      "       status: \"captured\" | \"failed\";",
      "+      /** @description Set when the charge replayed a recorded result. */",
      "+      replayed?: boolean;",
      "+      /** @description The idempotency key the charge was recorded under. */",
      "+      idempotencyKey: string;",
      "     };",
      "   };",
      " }",
    ],
  ),
  // A fourth unit's worth of code, in two files: long enough that the diff
  // pane scrolls, with reconcile.ts shown in two units (the wiring hunk is
  // in "wiring-and-docs"), for the browser suite in e2e/.
  h(
    "a1b2c3d4e5f6000d",
    "src/billing/reconcile.ts",
    "@@ -4,10 +4,30 @@ import type { Pool } from \"pg\";",
    4,
    10,
    4,
    30,
    [
      " import type { Pool } from \"pg\";",
      " import type { ChargeResult } from \"./types\";",
      " ",
      "-export interface ReconcileRow {",
      "-  key: string;",
      "-  ledger: ChargeResult | null;",
      "-}",
      "+/** One ledger row set against what the gateway reports for the same key. */",
      "+export interface ReconcileRow {",
      "+  key: string;",
      "+  orderId: string;",
      "+  ledger: ChargeResult | null;",
      "+  gateway: GatewayCharge | null;",
      "+  verdict: Verdict;",
      "+}",
      "+",
      "+export type Verdict = \"match\" | \"ledger-only\" | \"gateway-only\" | \"amount-mismatch\";",
      "+",
      "+export interface GatewayCharge {",
      "+  id: string;",
      "+  idempotencyKey: string;",
      "+  amount: number;",
      "+  currency: string;",
      "+}",
      "+",
      "+/** Rows whose ledger write failed mid-flight look like gateway-only charges. */",
      "+export function verdictFor(ledger: ChargeResult | null, gateway: GatewayCharge | null): Verdict {",
      "+  if (ledger && gateway) return ledger.id === gateway.id ? \"match\" : \"amount-mismatch\";",
      "+  if (ledger) return \"ledger-only\";",
      "+  return \"gateway-only\";",
      "+}",
      " ",
      " export class Reconciler {",
      "   constructor(",
    ],
  ),
  h(
    "a1b2c3d4e5f6000e",
    "src/billing/reconcile.ts",
    "@@ -40,9 +60,31 @@ export class Reconciler {",
    40,
    9,
    60,
    31,
    [
      "     private readonly pool: Pool,",
      "     private readonly gateway: Gateway,",
      "   ) {}",
      " ",
      "-  async run(): Promise<void> {",
      "-    throw new Error(\"not implemented\");",
      "-  }",
      "+  /**",
      "+   * Walk the ledger for `since` and fetch the matching gateway charges in",
      "+   * one batch per page: the gateway rate-limits per call, not per key.",
      "+   */",
      "+  async run(since: Date): Promise<ReconcileReport> {",
      "+    const report = new ReconcileReport(since);",
      "+    for await (const page of this.ledgerPages(since)) {",
      "+      const keys = page.map((row) => row.key);",
      "+      const remote = await this.gateway.chargesByKeys(keys);",
      "+      const byKey = new Map(remote.map((c) => [c.idempotencyKey, c]));",
      "+      for (const row of page) {",
      "+        const gateway = byKey.get(row.key) ?? null;",
      "+        report.add({",
      "+          key: row.key,",
      "+          orderId: row.order_id,",
      "+          ledger: row.result,",
      "+          gateway,",
      "+          verdict: verdictFor(row.result, gateway),",
      "+        });",
      "+        byKey.delete(row.key);",
      "+      }",
      "+      for (const orphan of byKey.values()) report.addGatewayOnly(orphan);",
      "+    }",
      "+    return report;",
      "+  }",
      " ",
      "   private async *ledgerPages(since: Date) {",
    ],
  ),
  h(
    "a1b2c3d4e5f6000f",
    "src/billing/reconcile.ts",
    "@@ -70,12 +112,34 @@ private async *ledgerPages(since: Date) {",
    70,
    12,
    112,
    34,
    [
      "     let after: string | null = null;",
      "     for (;;) {",
      "-      const { rows } = await this.pool.query(",
      "-        \"SELECT key, order_id, result FROM charge_ledger WHERE created_at >= $1 ORDER BY key LIMIT 500\",",
      "-        [since],",
      "-      );",
      "+      const { rows } = await this.pool.query<LedgerRow>(",
      "+        `SELECT key, order_id, result",
      "+           FROM charge_ledger",
      "+          WHERE created_at >= $1 AND ($2::text IS NULL OR key > $2)",
      "+          ORDER BY key",
      "+          LIMIT ${PAGE_SIZE}`,",
      "+        [since, after],",
      "+      );",
      "       if (rows.length === 0) return;",
      "       yield rows;",
      "-      if (rows.length < 500) return;",
      "+      after = rows[rows.length - 1].key;",
      "+      if (rows.length < PAGE_SIZE) return;",
      "     }",
      "   }",
      " }",
      "+",
      "+export class ReconcileReport {",
      "+  readonly rows: ReconcileRow[] = [];",
      "+  constructor(readonly since: Date) {}",
      "+",
      "+  add(row: ReconcileRow) {",
      "+    this.rows.push(row);",
      "+  }",
      "+",
      "+  addGatewayOnly(charge: GatewayCharge) {",
      "+    this.rows.push({ key: charge.idempotencyKey, orderId: \"\", ledger: null, gateway: charge, verdict: \"gateway-only\" });",
      "+  }",
      "+",
      "+  get mismatches(): ReconcileRow[] {",
      "+    return this.rows.filter((r) => r.verdict !== \"match\");",
      "+  }",
      "+}",
    ],
  ),
  h(
    "a1b2c3d4e5f60010",
    "src/billing/reconcile.ts",
    "@@ -110,5 +174,7 @@",
    110,
    5,
    174,
    7,
    [
      " /* ------------------------------------------------------------ wiring */",
      " ",
      "-export function buildReconciler(pool: Pool) {",
      "-  return new Reconciler(pool);",
      "+export function buildReconciler(pool: Pool, gateway: Gateway) {",
      "+  return new Reconciler(pool, gateway);",
      " }",
      "+",
      "+export const PAGE_SIZE = 500;",
    ],
  ),
  h(
    "a1b2c3d4e5f60011",
    "src/jobs/reconcileNightly.ts",
    "@@ -1,7 +1,15 @@",
    1,
    7,
    1,
    15,
    [
      " import { schedule } from \"../lib/cron\";",
      "-import { Reconciler } from \"../billing/reconcile\";",
      "+import { buildReconciler } from \"../billing/reconcile\";",
      "+import { alert } from \"../lib/alerts\";",
      " import { container } from \"../container\";",
      " ",
      "-schedule(\"0 3 * * *\", async () => {",
      "-  await new Reconciler(container.pool).run();",
      "-});",
      "+/** Nightly: everything charged yesterday, checked against the gateway. */",
      "+schedule(\"0 3 * * *\", async () => {",
      "+  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);",
      "+  const report = await buildReconciler(container.pool, container.gateway).run(since);",
      "+  if (report.mismatches.length === 0) return;",
      "+  await alert(\"billing-reconcile\", {",
      "+    title: `${report.mismatches.length} charge(s) out of step with the gateway`,",
      "+    rows: report.mismatches.map(describe),",
      "+  });",
      "+});",
    ],
  ),
  h(
    "a1b2c3d4e5f60012",
    "src/jobs/reconcileNightly.ts",
    "@@ -14,4 +22,13 @@",
    14,
    4,
    22,
    13,
    [
      " ",
      "-function describe(row: unknown): string {",
      "-  return JSON.stringify(row);",
      "+function describe(row: ReconcileRow): string {",
      "+  switch (row.verdict) {",
      "+    case \"ledger-only\":",
      "+      return `${row.key}: recorded locally, unknown to the gateway`;",
      "+    case \"gateway-only\":",
      "+      return `${row.key}: charged at the gateway, no ledger row`;",
      "+    case \"amount-mismatch\":",
      "+      return `${row.key}: ledger ${row.ledger?.id} vs gateway ${row.gateway?.id}`;",
      "+    default:",
      "+      return row.key;",
      "+  }",
      " }",
    ],
  ),
];

const files: FilesJson = {
  files: [
    {
      path: "src/billing/charge.ts",
      status: "modified",
      additions: 34,
      deletions: 3,
      hunks: [hunks[0], hunks[1]],
    },
    {
      path: "src/billing/idempotency.ts",
      status: "added",
      additions: 14,
      deletions: 0,
      hunks: [hunks[2]],
    },
    {
      path: "migrations/0042_charge_ledger.sql",
      status: "added",
      additions: 11,
      deletions: 0,
      hunks: [hunks[3]],
    },
    {
      path: "src/billing/ledger.ts",
      status: "modified",
      additions: 28,
      deletions: 0,
      hunks: [hunks[4]],
    },
    {
      path: "src/container.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      hunks: [hunks[5]],
    },
    {
      path: "src/api/routes/orders.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      hunks: [hunks[6]],
    },
    {
      path: "test/billing/charge.test.ts",
      status: "modified",
      additions: 22,
      deletions: 0,
      hunks: [hunks[7]],
    },
    {
      path: "docs/billing.md",
      status: "modified",
      additions: 6,
      deletions: 0,
      hunks: [hunks[8]],
    },
    {
      path: "src/billing/reconcile.ts",
      status: "modified",
      additions: 80,
      deletions: 14,
      hunks: [hunks[12], hunks[13], hunks[14], hunks[15]],
    },
    {
      path: "src/jobs/reconcileNightly.ts",
      status: "modified",
      additions: 23,
      deletions: 6,
      hunks: [hunks[16], hunks[17]],
    },
    {
      path: "pnpm-lock.yaml",
      status: "modified",
      additions: 8,
      deletions: 0,
      generated: { source: "lockfile" },
      hunks: [hunks[9]],
    },
    {
      path: "gen/proto/billing/v1/charge.pb.go",
      status: "added",
      additions: 12,
      deletions: 0,
      generated: { source: "path", detail: "*.pb.go" },
      hunks: [hunks[10]],
    },
    {
      path: "src/api/openapi.d.ts",
      status: "modified",
      additions: 4,
      deletions: 0,
      generated: { source: "gitattributes", detail: "src/api/*.d.ts linguist-generated" },
      hunks: [hunks[11]],
    },
  ],
};

const units: ReviewUnit[] = [
  {
    id: "idempotent-charge-path",
    title: "Idempotent charge path with ledger-backed replay",
    summary:
      "charge() now derives a stable idempotency key, short-circuits on a recorded result, and persists both success and failure in a new charge_ledger table.",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "Encodes the money-safety decision: what counts as the same charge.",
    riskFlags: ["money", "external-call"],
    findings: [
      {
        severity: "warning",
        text: "refundCharge() still keys off the raw orderId, so a replayed refund after a partial capture will not find the ledger row written by charge().",
        evidence: "src/payments/refund.ts:64, src/payments/ledger.ts:31",
      },
      {
        severity: "note",
        text: "All 3 callers of charge() propagate ChargeReplayed as a success; none treat it as an error.",
        evidence: "src/api/pay.ts:88, src/jobs/retryQueue.ts:41, test/payments/charge.test.ts:120",
      },
    ],
    changelog: [
      { revision: 2, text: "ledger write moved before the gateway call; failures are now recorded too" },
      { revision: 3, text: "key derivation drops the timestamp; added a replay-after-timeout test" },
    ],
    // a1b2c3d4e5f60004 (the migration, new in revision 3) is deliberately in
    // no unit: the sidebar's "Not in any unit" group needs something to show.
    hunkIds: ["a1b2c3d4e5f60001", "a1b2c3d4e5f60003", "a1b2c3d4e5f60005"],
    order: 1,
  },
  {
    id: "transient-retry-backoff",
    title: "Retry wrapper with jittered exponential backoff",
    summary:
      "Transient gateway failures are retried up to MAX_ATTEMPTS with doubling delay plus jitter. Non-transient errors propagate immediately.",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "Retry semantics interact with the idempotency key; wrong here double-charges.",
    riskFlags: ["concurrency", "external-call"],
    findings: [
      {
        severity: "note",
        text: "isTransient() is only reachable from the retry wrapper; no other call site classifies gateway errors.",
        evidence: "src/payments/retry.ts:22",
      },
      {
        severity: "note",
        text: "MAX_ATTEMPTS is read once at module load and is not overridden anywhere in the repo.",
        evidence: "src/payments/retry.ts:9",
      },
      {
        severity: "note",
        text: "The old chargeWithRetry() helper has no remaining references outside its own test file.",
        evidence: "src/payments/legacy.ts:14, test/payments/legacy.test.ts:3",
      },
    ],
    hunkIds: ["a1b2c3d4e5f60002", "a1b2c3d4e5f60008"],
    order: 2,
  },
  {
    id: "wiring-and-docs",
    title: "Container wiring, call-site threading and docs",
    summary:
      "ChargeLedger is constructed in the container and injected; the pay route threads a requestId through. Docs describe the new key derivation.",
    kind: "wiring",
    attention: "skip",
    attentionWhy: "Mechanical: registration, one signature threading, prose.",
    riskFlags: [],
    hunkIds: ["a1b2c3d4e5f60006", "a1b2c3d4e5f60007", "a1b2c3d4e5f60009", "a1b2c3d4e5f60010"],
    order: 3,
  },
  {
    id: "ledger-reconciliation",
    title: "Nightly reconciliation of the ledger against the gateway",
    summary:
      "A Reconciler pages through charge_ledger and fetches the gateway's charges for the same keys in batches; a nightly job alerts on every row whose verdict is not a match.",
    kind: "core-logic",
    attention: "skim",
    attentionWhy: "Read-only against money records; the verdict table is the part worth checking.",
    riskFlags: ["external-call"],
    findings: [
      {
        severity: "note",
        text: "verdictFor() calls two rows with different ids an amount-mismatch even when the amounts agree; the name promises more than the check.",
        evidence: "src/billing/reconcile.ts:27",
      },
    ],
    hunkIds: ["a1b2c3d4e5f6000d", "a1b2c3d4e5f6000e", "a1b2c3d4e5f6000f", "a1b2c3d4e5f60011", "a1b2c3d4e5f60012"],
    order: 4,
  },
  // Purview's own unit, built from the files' classification (not the analysis's).
  buildGeneratedUnit(files.files, 5)!,
];

/** A husk: every hunk of it left the PR in revision 3 (see ReviewUnit.removedAtRevision). */
const removedUnits: ReviewUnit[] = [
  {
    id: "ledger-cleanup-job",
    title: "Nightly job pruning settled ledger rows",
    summary:
      "A cron job deleted charge_ledger rows older than 30 days once their charge settled. Revision 3 dropped it: ledger retention is now left to the table's TTL policy.",
    kind: "core-logic",
    attention: "skim",
    attentionWhy: "Deletes money records; worth a look while it existed.",
    riskFlags: ["money"],
    hunkIds: [],
    order: 4,
    removedAtRevision: 3,
    readBeforeRemoval: true,
    changelog: [{ revision: 2, text: "retention window cut from 90 to 30 days" }],
  },
];

const state: PrState = {
  revision: 3,
  revisions: [
    { revision: 1, headSha: "4f2a9c1e7b3d5a60", addedAt: "2026-05-11T09:12:00.000Z" },
    { revision: 2, headSha: "9b1e3f7a2c4d8e10", addedAt: "2026-05-12T15:40:00.000Z" },
    { revision: 3, headSha: "c7d2e8b4a9f1360e", addedAt: "2026-05-13T10:05:00.000Z" },
  ],
  summary:
    "Payment charges become replay-safe. A key derived from (orderId, amount, currency) is recorded in a new charge_ledger table before the gateway call, so retries — whether from the client, the queue, or the new backoff wrapper — return the original result instead of charging twice. Two things deserve real attention: the key derivation (it must not include anything volatile) and the interaction between the retry loop and the ledger write ordering.",
  units,
  removedUnits,
  hunks: {
    a1b2c3d4e5f60001: { viewed: true, viewedAtRevision: 2, changedSinceViewed: true, migration: "fuzzy", predecessorId: "a1b2c3d4e5f6ff01" },
    a1b2c3d4e5f60002: { viewed: true, viewedAtRevision: 3, changedSinceViewed: false, migration: "identical" },
    a1b2c3d4e5f60003: { viewed: false, changedSinceViewed: false, migration: "identical" },
    a1b2c3d4e5f60004: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f60005: { viewed: false, changedSinceViewed: false, migration: "identical" },
    a1b2c3d4e5f60006: { viewed: true, viewedAtRevision: 3, changedSinceViewed: false },
    a1b2c3d4e5f60007: { viewed: false, changedSinceViewed: false },
    a1b2c3d4e5f60008: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f60009: { viewed: true, viewedAtRevision: 3, changedSinceViewed: false },
    a1b2c3d4e5f6000a: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f6000b: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f6000c: { viewed: false, changedSinceViewed: false, migration: "identical" },
    a1b2c3d4e5f6000d: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f6000e: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f6000f: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f60010: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f60011: { viewed: false, changedSinceViewed: false, migration: "new" },
    a1b2c3d4e5f60012: { viewed: false, changedSinceViewed: false, migration: "new" },
  },
  files: {
    "src/billing/charge.ts": { viewed: true, viewedHunks: 2, totalHunks: 2, syncedToGitHub: true },
    "src/billing/idempotency.ts": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "migrations/0042_charge_ledger.sql": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "src/billing/ledger.ts": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "src/container.ts": { viewed: true, viewedHunks: 1, totalHunks: 1 },
    "src/api/routes/orders.ts": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "test/billing/charge.test.ts": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "docs/billing.md": { viewed: true, viewedHunks: 1, totalHunks: 1 },
    "pnpm-lock.yaml": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "gen/proto/billing/v1/charge.pb.go": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "src/api/openapi.d.ts": { viewed: false, viewedHunks: 0, totalHunks: 1 },
    "src/billing/reconcile.ts": { viewed: false, viewedHunks: 0, totalHunks: 4 },
    "src/jobs/reconcileNightly.ts": { viewed: false, viewedHunks: 0, totalHunks: 2 },
  },
};

function buildDiffText(): string {
  const out: string[] = [];
  for (const f of files.files) {
    const old = f.status === "added" ? "/dev/null" : `a/${f.path}`;
    out.push(`diff --git a/${f.path} b/${f.path}`);
    if (f.status === "added") out.push("new file mode 100644");
    out.push(`--- ${old}`);
    out.push(`+++ b/${f.path}`);
    for (const hk of f.hunks) {
      out.push(hk.header);
      out.push(...(hk.lines ?? []));
    }
  }
  return out.join("\n") + "\n";
}

export const mockDetail: PrDetail = {
  key: MOCK_KEY,
  meta,
  state,
  files,
  diff: buildDiffText(),
  // You approved revision 2; revision 3 then changed one hunk and added one.
  sinceReview: {
    revision: 2,
    ts: "2026-05-12T18:20:00.000Z",
    event: "APPROVE",
    url: "https://github.com/acme/billing/pull/482#pullrequestreview-1",
    changedHunkIds: ["a1b2c3d4e5f60001", "a1b2c3d4e5f60004"],
  },
};

/**
 * `addedAt` is anchored to load time rather than hard-coded, so the list always
 * exercises both branches of the stamp: minutes/hours/days render relative, and
 * the deliberately-old row (11 days) renders as an absolute date.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.now();
const ago = (ms: number) => new Date(START - ms).toISOString();

export const mockList: PrListEntry[] = [
  // --- acme/billing: several PRs, mixed states, one archived ---------------
  {
    key: MOCK_KEY,
    meta,
    title: meta.title,
    unitCount: units.length,
    viewedHunks: 4,
    totalHunks: 9,
    effort: { mustReadLines: 1840, weightedMustReadLines: 1710, mustReadUnits: 3, riskCount: 2, badge: "heavy" },
    state: "open",
    reviewDecision: "changes_requested",
    // Past the 3-day mark, so the list shows it in the warning color.
    reviewRequest: { at: ago(4 * DAY + 2 * HOUR), by: "dana", via: "you" },
    addedAt: ago(2 * DAY + 3 * HOUR),
    archived: false,
  },
  {
    key: "github.com/acme/billing/491",
    meta: {
      host: "github.com",
      owner: "acme",
      repo: "billing",
      number: 491,
      url: "https://github.com/acme/billing/pull/491",
      title: "WIP: split the ledger writer out of ChargeService",
      author: "you",
    },
    title: "WIP: split the ledger writer out of ChargeService",
    unitCount: 3,
    viewedHunks: 0,
    totalHunks: 6,
    state: "draft",
    reviewDecision: null,
    // Your own draft: the list files it under "Your PRs".
    authoredByYou: true,
    addedAt: ago(40 * MINUTE),
    archived: false,
  },
  {
    key: "github.com/acme/billing/502",
    meta: {
      host: "github.com",
      owner: "acme",
      repo: "billing",
      number: 502,
      url: "https://github.com/acme/billing/pull/502",
      title: "Retry webhook delivery with jittered backoff",
      // Opened by an agent from its bot account. The mock's global config lists
      // the login in `extraAuthors`, so the list files it under "Your PRs"
      // while the row keeps naming the bot.
      author: "primitos[bot]",
    },
    title: "Retry webhook delivery with jittered backoff",
    unitCount: 2,
    viewedHunks: 1,
    totalHunks: 4,
    effort: { mustReadLines: 160, weightedMustReadLines: 120, mustReadUnits: 1, riskCount: 0, badge: null },
    state: "open",
    reviewDecision: null,
    addedAt: ago(3 * HOUR + 12 * MINUTE),
    archived: false,
  },
  {
    key: "github.com/acme/billing/474",
    meta: {
      host: "github.com",
      owner: "acme",
      repo: "billing",
      number: 474,
      url: "https://github.com/acme/billing/pull/474",
      title: "Add currency to the idempotency key derivation",
    },
    title: "Add currency to the idempotency key derivation",
    unitCount: 2,
    viewedHunks: 5,
    totalHunks: 5,
    effort: { mustReadLines: 42, weightedMustReadLines: 28, mustReadUnits: 1, riskCount: 0, badge: "fast" },
    state: "merged",
    reviewDecision: "approved",
    addedAt: ago(6 * DAY),
    archived: false,
  },
  {
    key: "github.com/acme/billing/468",
    meta: {
      host: "github.com",
      owner: "acme",
      repo: "billing",
      number: 468,
      url: "https://github.com/acme/billing/pull/468",
      title: "Retire the v1 refunds endpoint",
    },
    title: "Retire the v1 refunds endpoint",
    unitCount: 1,
    viewedHunks: 1,
    totalHunks: 4,
    state: "closed",
    reviewDecision: null,
    addedAt: ago(11 * DAY),
    archived: true,
  },
  // --- acme/platform: a single, never-analyzed PR --------------------------
  {
    key: "github.com/acme/platform/1190",
    meta: {
      host: "github.com",
      owner: "acme",
      repo: "platform",
      number: 1190,
      url: "https://github.com/acme/platform/pull/1190",
      title: "Drop legacy session cookie fallback",
    },
    title: "Drop legacy session cookie fallback",
    unitCount: 0,
    viewedHunks: 0,
    totalHunks: 0,
    state: "open",
    reviewDecision: "review_required",
    reviewRequest: { at: ago(5 * HOUR + 20 * MINUTE), by: "priya", via: "team:platform-core" },
    addedAt: ago(5 * HOUR),
    archived: false,
  },
  // --- a self-hosted repo, the one carrying a committed .purview/ config ---
  {
    key: "git.acme.dev/infra/terraform-modules/77",
    meta: {
      host: "git.acme.dev",
      owner: "infra",
      repo: "terraform-modules",
      number: 77,
      url: "https://git.acme.dev/infra/terraform-modules/pull/77",
      title: "Pin the RDS module and drop the inline security group",
    },
    title: "Pin the RDS module and drop the inline security group",
    unitCount: 4,
    viewedHunks: 2,
    totalHunks: 7,
    state: "open",
    reviewDecision: "approved",
    addedAt: ago(26 * HOUR),
    archived: false,
  },
];

/**
 * The committed rubric lives in the target repo's `.purview/` folder; the mock
 * carries one so the repo settings page has a non-empty read-only pane.
 */
export const MOCK_COMMITTED_RUBRIC = `# Review rubric — infra/terraform-modules

Everything in this repo ships to production infrastructure, so the bar is
higher than for application code.

## Always must-read

- Any change under \`modules/rds/\` or \`modules/networking/\`.
- Security group rules, IAM policies, and anything that widens a CIDR.
- Version pins: an unpinned module source is a blocking finding.

## Skim

- Variable descriptions, outputs, and \`README.md\` regeneration.
- \`.tflint.hcl\` and formatting-only churn.

## Conventions

1. Modules are versioned with \`?ref=vX.Y.Z\`, never a branch.
2. State backends are configured per-environment, never inline.
3. Every resource carries the standard \`owner\` / \`cost-center\` tags.

Flag anything that would need a \`terraform state mv\` to land safely.
`;

const LOCAL_BILLING_RUBRIC = `Money paths first: charge, refund, ledger writes.
Treat any change to idempotency key derivation as must-read even if it looks cosmetic.
`;

/**
 * The committed chat instructions live in the target repo's `.purview/CHAT.md`;
 * mirrors MOCK_COMMITTED_RUBRIC so the "Chat instructions" pane has a
 * non-empty read-only example too.
 */
export const MOCK_COMMITTED_CHAT_INSTRUCTIONS = `# Chat instructions — infra/terraform-modules

When asked about a module's blast radius, check \`modules/networking/\` and
\`modules/rds/\` dependents before answering — most incidents here trace back
to an unnoticed fan-out through those two.

Keep answers short; this team reads chat on a phone during on-call.
`;

const LOCAL_BILLING_CHAT_INSTRUCTIONS = `When asked about tests, point at packages/billing/test/e2e first.
`;

export const mockRepos: RepoSummary[] = [
  {
    host: "github.com",
    owner: "acme",
    repo: "billing",
    prCount: 3,
    archivedCount: 1,
    hasLocalConfig: true,
    hasCommittedConfig: false,
    repoPath: "/Users/dana/code/billing",
    watchReviews: true,
    watch: { checkedAt: new Date(Date.now() - 3 * 60_000).toISOString(), imported: 0 },
  },
  {
    host: "github.com",
    owner: "acme",
    repo: "platform",
    prCount: 1,
    archivedCount: 0,
    hasLocalConfig: false,
    hasCommittedConfig: false,
    repoPath: null,
    watchReviews: false,
    watch: null,
  },
  {
    host: "git.acme.dev",
    owner: "infra",
    repo: "terraform-modules",
    prCount: 1,
    archivedCount: 0,
    hasLocalConfig: false,
    hasCommittedConfig: true,
    repoPath: null,
    watchReviews: false,
    watch: null,
  },
];

/** A resolved Claude Code agent, as the fixture's layers add up to it. */
function claudeCode(
  model: string,
  modelSource: ConfigSource,
  effort?: [string, ConfigSource],
): ResolvedAgent {
  const harnessSource = modelSource === "default" && (!effort || effort[1] === "default") ? "default" : modelSource;
  return {
    harness: "claude-code",
    model,
    ...(effort ? { effort: effort[0] } : {}),
    sources: { harness: harnessSource, model: modelSource, ...(effort ? { effort: effort[1] } : {}) },
  };
}

export const mockRepoConfigs: Record<string, RepoConfig> = {
  "github.com/acme/billing": {
    local: {
      autoAnalyze: true,
      repoPath: "/Users/dana/code/billing",
      analysisAgent: { harness: "claude-code", model: "opus" },
      chatAgent: null,
      watchReviews: true,
      rubric: LOCAL_BILLING_RUBRIC,
      chatInstructions: LOCAL_BILLING_CHAT_INSTRUCTIONS,
      generated: { include: ["fixtures/recorded/**"], exclude: [] },
    },
    committed: { present: false, config: null, rubric: null, chat: null },
    effective: {
      autoAnalyze: true,
      repoPath: "/Users/dana/code/billing",
      analysisAgent: claudeCode("opus", "repo", ["medium", "default"]),
      chatAgent: claudeCode("sonnet", "default"),
    },
    sources: { autoAnalyze: "repo", repoPath: "repo" },
  },
  "github.com/acme/platform": {
    local: {
      autoAnalyze: null,
      repoPath: null,
      analysisAgent: null,
      chatAgent: null,
      watchReviews: null,
      rubric: "",
      chatInstructions: "",
    },
    committed: { present: false, config: null, rubric: null, chat: null },
    effective: {
      autoAnalyze: false,
      repoPath: null,
      analysisAgent: claudeCode("sonnet", "default", ["medium", "default"]),
      chatAgent: claudeCode("sonnet", "default"),
    },
    sources: { autoAnalyze: "default", repoPath: "default" },
  },
  "git.acme.dev/infra/terraform-modules": {
    local: {
      autoAnalyze: null,
      repoPath: null,
      analysisAgent: null,
      chatAgent: null,
      watchReviews: null,
      rubric: "",
      chatInstructions: "",
    },
    committed: {
      present: true,
      config: {
        autoAnalyze: true,
        analysisAgent: { harness: "claude-code", model: "opus" },
        chatAgent: { harness: "claude-code", model: "haiku" },
      },
      rubric: MOCK_COMMITTED_RUBRIC,
      chat: MOCK_COMMITTED_CHAT_INSTRUCTIONS,
    },
    effective: {
      autoAnalyze: true,
      repoPath: null,
      analysisAgent: claudeCode("opus", "committed", ["medium", "default"]),
      chatAgent: claudeCode("haiku", "committed"),
    },
    sources: { autoAnalyze: "committed", repoPath: "default" },
  },
};

export const mockDrafts: DraftComment[] = [
  {
    id: "draft-1",
    file: "src/billing/charge.ts",
    line: 24,
    side: "RIGHT",
    subjectType: "line",
    body: "Should the ledger write happen before the gateway call so a crash mid-flight is still replay-safe?",
    createdAt: "2026-08-12T08:31:00Z",
    status: "draft",
  },
  // Three on one line, one of each status: the bubble must paint itself with
  // the most advanced one (submitted) rather than the first one it meets.
  {
    id: "draft-2",
    file: "src/billing/idempotency.ts",
    line: 9,
    side: "RIGHT",
    subjectType: "line",
    body: "sha256 over a template string will collide if any field can contain the separator.",
    createdAt: "2026-08-12T08:44:00Z",
    status: "pushed",
    githubCommentId: 90210,
    githubThreadId: "PRRT_idem9_pending",
  },
  {
    id: "draft-5",
    file: "src/billing/idempotency.ts",
    line: 9,
    side: "RIGHT",
    subjectType: "line",
    body: "Follow-up: `#` is a safe separator here because none of the three fields can contain it.\n\nWorth a **unit test** either way.",
    createdAt: "2026-08-12T09:02:00Z",
    status: "draft",
  },
  {
    id: "draft-6",
    file: "src/billing/idempotency.ts",
    line: 9,
    side: "RIGHT",
    subjectType: "line",
    body: "Already raised this one publicly last round — see the thread above.",
    createdAt: "2026-08-11T11:20:00Z",
    status: "submitted",
    githubCommentId: 90150,
    githubThreadId: "PRRT_idem9_public",
  },
  {
    id: "draft-3",
    file: "src/billing/ledger.ts",
    line: 12,
    side: "RIGHT",
    subjectType: "line",
    // No githubCommentId on purpose: exercises the remote.ok=false path.
    body: "Does this need an index on (key) to keep the replay lookup cheap?",
    createdAt: "2026-08-11T17:02:00Z",
    status: "pushed",
  },
  {
    id: "draft-4",
    file: "src/api/routes/orders.ts",
    line: 46,
    side: "RIGHT",
    subjectType: "line",
    body: "Already public: the 409 here should probably be a 200 with the original result.",
    createdAt: "2026-08-10T12:15:00Z",
    status: "submitted",
    githubCommentId: 90180,
    githubThreadId: "PRRT_orders46",
  },
  // A reply to @maria's thread on the retry wrapper, not sent yet: it shows at
  // the end of that thread, not as a comment of its own.
  {
    id: "draft-9",
    file: "src/billing/charge.ts",
    line: 25,
    side: "RIGHT",
    subjectType: "line",
    body: "Agreed on the adapter in the long run — but the ledger key has to be computed here anyway, so the retry stays next to it for now.",
    createdAt: "2026-08-12T09:20:00Z",
    status: "draft",
    inReplyTo: "PRRT_charge25",
  },
  // Multi-line: covers the whole `if (!res.ok)` block, marker on its last line.
  {
    id: "draft-10",
    file: "src/billing/charge.ts",
    line: 31,
    side: "RIGHT",
    startLine: 28,
    startSide: "RIGHT",
    subjectType: "line",
    body: "Recording the failure and then throwing means a *transient* gateway error leaves a failure row behind — the retry above only wraps `charge`, not this block. Should `recordFailure` only run for non-transient codes?",
    createdAt: "2026-08-12T09:25:00Z",
    status: "draft",
  },
  // A suggestion: GitHub renders the fenced block as a one-click change over line 33.
  {
    id: "draft-11",
    file: "src/billing/charge.ts",
    line: 33,
    side: "RIGHT",
    subjectType: "line",
    body: "Stamp the row, so a replay can tell a fresh result from one that has aged out:\n\n```suggestion\n    await this.ledger.record(key, result, { at: this.clock.now() });\n```",
    createdAt: "2026-08-12T09:32:00Z",
    status: "draft",
  },
  // Anchored to the OLD side: in split view its bubble belongs on the left half.
  {
    id: "draft-8",
    file: "src/billing/charge.ts",
    line: 22,
    side: "LEFT",
    subjectType: "line",
    body: "This is the throw the retry wrapper replaces — worth calling that out in the commit message.",
    createdAt: "2026-08-12T09:14:00Z",
    status: "draft",
  },
  // File-level: no line, no side.
  {
    id: "draft-7",
    file: "src/billing/charge.ts",
    line: null,
    side: null,
    subjectType: "file",
    body: "This file is now doing retries, idempotency *and* ledger writes. Worth splitting the retry policy out before it grows again.",
    createdAt: "2026-08-12T09:10:00Z",
    status: "draft",
  },
];

/* ------------------------------------------------- GitHub review threads */

const VIEWER = "franco";
const avatar = (login: string) => `https://avatars.githubusercontent.com/${login}?s=40`;
let commentSeq = 0;
function remote(
  login: string,
  body: string,
  createdAt: string,
  over: Partial<RemoteComment> & { bot?: boolean; botName?: string } = {},
): RemoteComment {
  const { bot = false, botName, ...rest } = over;
  const databaseId = rest.databaseId ?? 91000 + ++commentSeq;
  return {
    id: `PRRC_${databaseId}`,
    databaseId,
    author: { login, bot, botName, avatarUrl: bot ? undefined : avatar(login) },
    body,
    createdAt,
    url: `https://github.com/acme/billing/pull/482#discussion_r${databaseId}`,
    reviewState: "SUBMITTED",
    isMine: login === VIEWER,
    ...rest,
  };
}

function thread(over: Partial<RemoteThread> & Pick<RemoteThread, "id" | "path" | "comments">): RemoteThread {
  return {
    subjectType: "line",
    line: null,
    originalLine: null,
    startLine: null,
    originalStartLine: null,
    startSide: null,
    side: "RIGHT",
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    ...over,
  };
}

const RABBIT = { bot: true, botName: "CodeRabbit" };

const CODERABBIT_MAJOR = `_🔐 Correctness_ | _🟠 Major_ | _⚡ Quick win_

**Separator collision in the idempotency key.**

\`orderId\` is caller-supplied and may contain \`:\`, so \`("a:1", 2, "EUR")\` and \`("a", 1, "2:EUR")\` hash to the same key. Two distinct charges would then share a ledger row, and the second one would silently return the first one's result.

Length-prefix the fields (or hash a JSON array) so the encoding is unambiguous:

\`\`\`suggestion
    .update(JSON.stringify([orderId, amount, currency]))
\`\`\`

<details>
<summary>🤖 Prompt for AI Agents</summary>

\`\`\`
In src/billing/idempotency.ts around line 10, the key is built from a
template string joined with ":", which collides when orderId contains ":".
Replace the template with an unambiguous encoding such as
JSON.stringify([orderId, amount, currency]) and add a unit test with two
inputs that collide under the old encoding.
\`\`\`

</details>

<!-- fingerprinting:phantom:poseidon:mock-a1 -->

<!-- This is an auto-generated comment by CodeRabbit -->`;

const CODERABBIT_NITPICK = `_🧹 Maintainability_ | _🔵 Trivial_ | _⚡ Quick win_

<details>
<summary>Record the ledger row and the charge in one transaction</summary>

If the process dies between \`gateway.charge\` resolving and \`ledger.record\`, the retry path has no row to find and charges again. Consider an outbox row written before the gateway call.

</details>

<!-- This is an auto-generated comment by CodeRabbit -->`;

export const mockThreads: RemoteThread[] = [
  // People talking it through, with the reader's own reply still a draft (draft-9).
  thread({
    id: "PRRT_charge25",
    path: "src/billing/charge.ts",
    line: 25,
    originalLine: 25,
    comments: [
      remote(
        "maria",
        "Why retry here rather than inside the gateway adapter? Every other caller of `gateway.charge` would want the same backoff.",
        "2026-08-11T14:02:00Z",
      ),
      remote(
        "dana",
        "The adapter doesn't know the idempotency key, and retrying without it is exactly the double-charge bug. Happy to move it once the key is part of the adapter API.",
        "2026-08-11T15:40:00Z",
        { updatedAt: "2026-08-11T15:52:00Z" },
      ),
      remote("maria", "Fair. Can you leave a `TODO(BILL-1190)` so we don't forget?", "2026-08-11T16:05:00Z"),
    ],
  }),
  // Multi-line: @maria on the backoff lines of the retry loop (77–79).
  thread({
    id: "PRRT_charge77_79",
    path: "src/billing/charge.ts",
    line: 79,
    originalLine: 79,
    startLine: 77,
    originalStartLine: 77,
    startSide: "RIGHT",
    comments: [
      remote(
        "maria",
        "With `delay + random() * delay` the wait can reach `2 * delay` *and then* doubles — the third attempt may sit ~1.6s. Cap the backoff, or jitter inside a fixed window?",
        "2026-08-11T14:20:00Z",
      ),
      remote(
        "dana",
        "Good catch — cap it and use full jitter:\n\n```suggestion\n        if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;\n        await sleep(Math.min(MAX_BACKOFF_MS, Math.random() * delay));\n        delay *= 2;\n```",
        "2026-08-11T15:45:00Z",
      ),
    ],
  }),
  // Resolved: collapses to one line.
  thread({
    id: "PRRT_ledger17",
    path: "src/billing/ledger.ts",
    line: 17,
    originalLine: 17,
    isResolved: true,
    resolvedBy: "dana",
    viewerCanResolve: false,
    viewerCanUnresolve: true,
    comments: [
      remote(
        "oliver",
        "`ON CONFLICT DO NOTHING` swallows a second write for the same key — is that intended, or should it at least log?",
        "2026-08-10T09:30:00Z",
      ),
      remote("dana", "Intended: the first outcome wins. Added a comment above the query.", "2026-08-10T11:12:00Z"),
    ],
  }),
  // Outdated: the line it was written on is gone.
  thread({
    id: "PRRT_charge_old",
    path: "src/billing/charge.ts",
    line: null,
    originalLine: 20,
    isOutdated: true,
    comments: [
      remote(
        "oliver",
        "This throws `ChargeFailed` before anything is recorded — a retry after a timeout can't tell a decline from a lost response.",
        "2026-08-09T16:45:00Z",
      ),
      remote("dana", "Reworked in the next push: failures go to the ledger first.", "2026-08-10T08:03:00Z"),
    ],
  }),
  // CodeRabbit, in its real format.
  thread({
    id: "PRRT_idem10_rabbit",
    path: "src/billing/idempotency.ts",
    line: 10,
    originalLine: 10,
    comments: [remote("coderabbitai[bot]", CODERABBIT_MAJOR, "2026-08-09T10:30:00Z", RABBIT)],
  }),
  // Copilot.
  thread({
    id: "PRRT_charge29_copilot",
    path: "src/billing/charge.ts",
    line: 29,
    originalLine: 29,
    comments: [
      remote(
        "Copilot",
        "If `recordFailure` itself throws, the original `ChargeFailed` is lost and the caller sees a database error instead. Consider recording the failure in a `try/finally` or logging and rethrowing the original error.",
        "2026-08-09T10:41:00Z",
        { bot: true, botName: "Copilot" },
      ),
    ],
  }),
  // Two separate threads on the same line, both remote.
  thread({
    id: "PRRT_charge33_a",
    path: "src/billing/charge.ts",
    line: 33,
    originalLine: 33,
    comments: [
      remote(
        "maria",
        "Nit: `record` after the gateway call means a crash in between charges twice on retry. Probably fine for now given the gateway's own idempotency header?",
        "2026-08-11T14:10:00Z",
      ),
    ],
  }),
  thread({
    id: "PRRT_charge33_rabbit",
    path: "src/billing/charge.ts",
    line: 33,
    originalLine: 33,
    comments: [remote("coderabbitai[bot]", CODERABBIT_NITPICK, "2026-08-09T10:31:00Z", RABBIT)],
  }),
  // Started by a comment pushed from Purview (draft-4), with an answer.
  thread({
    id: "PRRT_orders46",
    path: "src/api/routes/orders.ts",
    line: 46,
    originalLine: 46,
    comments: [
      remote(VIEWER, "Already public: the 409 here should probably be a 200 with the original result.", "2026-08-10T12:16:00Z", {
        databaseId: 90180,
      }),
      remote(
        "dana",
        "Good call — a replayed pay request should look exactly like the first one to the client. Changing it.",
        "2026-08-10T13:02:00Z",
      ),
    ],
  }),
  // Purview's own on idempotency.ts:9: one in the pending review, one public.
  thread({
    id: "PRRT_idem9_pending",
    path: "src/billing/idempotency.ts",
    line: 9,
    originalLine: 9,
    comments: [
      remote(VIEWER, "sha256 over a template string will collide if any field can contain the separator.", "2026-08-12T08:45:00Z", {
        databaseId: 90210,
        reviewState: "PENDING",
      }),
    ],
  }),
  thread({
    id: "PRRT_idem9_public",
    path: "src/billing/idempotency.ts",
    line: 9,
    originalLine: 9,
    comments: [
      remote(VIEWER, "Already raised this one publicly last round — see the thread above.", "2026-08-11T11:21:00Z", {
        databaseId: 90150,
      }),
    ],
  }),
  // A whole-file thread.
  thread({
    id: "PRRT_docs_file",
    path: "docs/billing.md",
    subjectType: "file",
    comments: [
      remote(
        "oliver",
        "Could this page say what happens to a charge that is still *pending* at the gateway when the retry kicks in?",
        "2026-08-11T09:00:00Z",
      ),
    ],
  }),
];

/* ------------------------------------------- reviews and conversation */

let reviewSeq = 0;
function review(
  login: string,
  state: RemoteReview["state"],
  submittedAt: string,
  over: Partial<RemoteReview> & { bot?: boolean; botName?: string } = {},
): RemoteReview {
  const { bot = false, botName, ...rest } = over;
  const databaseId = 3100000 + ++reviewSeq;
  return {
    id: `PRR_${databaseId}`,
    databaseId,
    author: { login, bot, botName, avatarUrl: bot ? undefined : avatar(login) },
    state,
    body: "",
    submittedAt,
    url: `https://github.com/acme/billing/pull/482#pullrequestreview-${databaseId}`,
    commentCount: 0,
    isMine: login === VIEWER,
    ...rest,
  };
}

let issueSeq = 0;
function said(
  login: string,
  body: string,
  createdAt: string,
  over: Partial<RemoteConversationComment> & { bot?: boolean; botName?: string } = {},
): RemoteConversationComment {
  const { bot = false, botName, ...rest } = over;
  const databaseId = 2400000 + ++issueSeq;
  return {
    id: `IC_${databaseId}`,
    databaseId,
    author: { login, bot, botName, avatarUrl: bot ? undefined : avatar(login) },
    body,
    createdAt,
    url: `https://github.com/acme/billing/pull/482#issuecomment-${databaseId}`,
    isMine: login === VIEWER,
    ...rest,
  };
}

const CODERABBIT_REVIEW = `**Actionable comments posted: 2**

<details>
<summary>🧹 Nitpick comments (1)</summary>

<details>
<summary>src/billing/retry.ts (1)</summary>

\`22-24\`: **Jitter is computed but never applied.**

\`withJitter(delay)\` returns a new value; the result is discarded, so every retry waits exactly \`base * 2^n\`.

</details>

</details>

<details>
<summary>📜 Review details</summary>

**Configuration used**: CodeRabbit UI
**Review profile**: CHILL

</details>
<!-- This is an auto-generated comment by CodeRabbit for review status -->`;

const CODERABBIT_WALKTHROUGH = `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->
<!-- walkthrough_start -->

## Walkthrough

\`charge()\` now derives an idempotency key per order and records every attempt in a new \`charge_ledger\` table before calling the gateway. Retries go through \`withRetry\`, which backs off exponentially and replays the ledger row instead of charging twice.

## Changes

| Cohort / File(s) | Summary |
|---|---|
| **Idempotency** <br> \`src/billing/idempotency.ts\` | New \`idempotencyKey(orderId, amount, currency)\` (sha256). |
| **Ledger** <br> \`src/billing/ledger.ts\`, \`migrations/0042_charge_ledger.sql\` | \`ChargeLedger\` with \`find\` / \`record\`; unique index on the key. |
| **Retry** <br> \`src/billing/retry.ts\` | \`withRetry\` with exponential backoff. |

<details>
<summary>📜 Sequence diagram</summary>

\`\`\`mermaid
sequenceDiagram
  participant API
  participant Ledger
  participant Gateway
  API->>Ledger: find(key)
  Ledger-->>API: none
  API->>Gateway: charge
  API->>Ledger: record(key, result)
\`\`\`

</details>

## Estimated code review effort

🎯 3 (Moderate) | ⏱️ ~25 minutes

<!-- walkthrough_end -->
<!-- tips_start -->

---

Thanks for using CodeRabbit! It's free for OSS, and your support helps us grow.

<!-- tips_end -->`;

export const mockReviews: RemoteReview[] = [
  review("coderabbitai", "COMMENTED", "2026-08-09T10:32:00Z", {
    ...RABBIT,
    body: CODERABBIT_REVIEW,
    commentCount: 2,
  }),
  review("maria", "CHANGES_REQUESTED", "2026-08-09T15:40:00Z", {
    body: "The retry wrapper swallows the gateway's 4xx and retries them too — a declined card shouldn't be retried at all. Also see the inline note on the ledger write order.",
    commentCount: 1,
  }),
  // The author answering threads: GitHub files each batch of replies as a review.
  review("dana", "COMMENTED", "2026-08-10T11:13:00Z", { commentCount: 2 }),
  review(VIEWER, "COMMENTED", "2026-08-10T12:16:00Z", {
    body: "Mostly reads well. Left a note on the 409 — happy to approve once the replay path returns the original result.",
    commentCount: 1,
  }),
  review("oliver", "APPROVED", "2026-08-11T09:02:00Z", { commentCount: 1 }),
  review("maria", "COMMENTED", "2026-08-11T16:05:00Z", { commentCount: 1 }),
];

export const mockConversation: RemoteConversationComment[] = [
  said("coderabbitai", CODERABBIT_WALKTHROUGH, "2026-08-09T10:20:00Z", { ...RABBIT, updatedAt: "2026-08-10T08:10:00Z" }),
  said(
    "dana",
    "Pushed the ledger-first ordering and the 4xx short-circuit. @maria the declined-card case now fails fast — see `isRetryable` in retry.ts.",
    "2026-08-10T08:05:00Z",
  ),
];
