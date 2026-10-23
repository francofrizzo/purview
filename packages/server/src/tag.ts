import { listPrs, MetaSchema, readMeta, stateRoot, writeMeta, type PrKey } from "@reviewer/core";

export const TagSchema = MetaSchema.shape.tag.unwrap();

/**
 * The PRs connected to `key` through base links (a stack: each PR targets
 * the branch of the one below), in the same repo, archived ones left out.
 * Always contains `key` itself. Walks both ways, so a PR in the middle of
 * a stack finds the ones above and below.
 */
export function stackOf(key: PrKey, root = stateRoot()): PrKey[] {
  const sameRepo = listPrs(root).filter((k) => k.host === key.host && k.owner === key.owner && k.repo === key.repo);
  const metas = new Map(sameRepo.map((k) => [k.number, readMeta(k, root)]));
  const edges = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  };
  for (const [number, meta] of metas) {
    const base = meta.basePr?.number;
    if (base === undefined || !metas.has(base)) continue;
    if (meta.archived || metas.get(base)!.archived) continue;
    link(number, base);
    link(base, number);
  }
  const seen = new Set<number>([key.number]);
  const queue = [key.number];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of edges.get(n) ?? []) if (!seen.has(m)) {
      seen.add(m);
      queue.push(m);
    }
  }
  return sameRepo.filter((k) => seen.has(k.number));
}

/** Sets (or with `null` clears) the tag on one PR; with `stack`, on its whole stack. Returns the PR's new meta and every key touched. */
export function setTagFor(key: PrKey, tag: string | null, root = stateRoot(), opts: { stack?: boolean } = {}) {
  const keys = opts.stack ? stackOf(key, root) : [key];
  const write = (k: PrKey) => {
    const { tag: _drop, ...rest } = readMeta(k, root);
    const meta = tag === null ? rest : { ...rest, tag: TagSchema.parse(tag) };
    writeMeta(k, meta, root);
    return meta;
  };
  const metas = keys.map(write);
  const own = metas[keys.findIndex((k) => k.number === key.number)]!;
  return { ...own, stack: keys.map((k) => `${k.host}/${k.owner}/${k.repo}/${k.number}`) };
}
