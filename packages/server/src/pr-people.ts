import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pullRequestMetadata, reviewDecisionArgs, parseReviewDecisionResponse, keyToString, readMeta, updateMeta, type Meta, type PrKey, type PrState, type ReviewDecision } from "@reviewer/core";

const exec = promisify(execFile);
type Run = (args: string[]) => Promise<any>;
const runGh: Run = async (args) => {
  const { stdout } = await exec("gh", args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};
export interface PrPerson {
  author?: string;
  authorAvatarUrl?: string;
  title?: string;
  state?: PrState;
  reviewDecision?: ReviewDecision | null;
  relationship: "own" | "review" | "other" | "unknown";
}

/** Independent of diff fetching: old tracked PRs get authors without reanalysis. */
export function createPrPeopleLoader(run: Run = runGh) {
  let cache: { signature: string; expires: number; result: Record<string, PrPerson> } | undefined;
  let pending: { signature: string; promise: Promise<Record<string, PrPerson>> } | undefined;
  return function load(keys: PrKey[], force = false): Promise<Record<string, PrPerson>> {
    const signature = keys.map(keyToString).sort().join("\n");
    if (!force && cache?.signature === signature && cache.expires > Date.now()) return Promise.resolve(cache.result);
    if (pending?.signature === signature) return pending.promise;
    const promise = (async () => {
      const result: Record<string, PrPerson> = {};
      for (const host of new Set(keys.map((k) => k.host))) {
        const hostKeys = keys.filter((k) => k.host === host);
        const api = (args: string[]) => run(["api", "--hostname", host, ...args]);
        let login: string | undefined;
        let reviews: Set<string> | undefined;
        try {
          const user = await api(["user"]);
          if (typeof user.login !== "string" || !/^[a-zA-Z0-9-]+$/.test(user.login)) throw new Error("Missing GitHub identity");
          login = user.login;
          const found = new Set<string>();
          for (let page = 1; page <= 10; page++) {
            const search = await api(["--method", "GET", "search/issues", "-f", `q=is:pr is:open review-requested:${login}`, "-F", "per_page=100", "-F", `page=${page}`]);
            if (search.incomplete_results || search.total_count > 1000 || !Array.isArray(search.items)) throw new Error("Incomplete review requests");
            for (const item of search.items) if (typeof item.html_url === "string") found.add(item.html_url.toLowerCase());
            if (page * 100 >= search.total_count || search.items.length < 100) break;
          }
          reviews = found;
        } catch { /* Unknown relationships remain explicit; authors can still load. */ }
        for (let offset = 0; offset < hostKeys.length; offset += 4) {
          await Promise.all(hostKeys.slice(offset, offset + 4).map(async (key) => {
            const id = keyToString(key);
            try {
              const pr = await api([`repos/${key.owner}/${key.repo}/pulls/${key.number}`]);
              const metadata = pullRequestMetadata(pr);
              const author = metadata.author;
              let reviewDecision: ReviewDecision | null | undefined;
              try {
                reviewDecision = parseReviewDecisionResponse(await run(reviewDecisionArgs(key)));
              } catch { /* Preserve the last known decision when GitHub is unavailable. */ }
              result[id] = {
                author,
                ...(metadata.authorAvatarUrl ? { authorAvatarUrl: metadata.authorAvatarUrl } : {}),
                ...(metadata.title !== undefined ? { title: metadata.title } : {}),
                ...(metadata.prState !== undefined ? { state: metadata.prState } : {}),
                ...(reviewDecision !== undefined ? { reviewDecision } : {}),
                relationship:
                author && login && author.toLowerCase() === login.toLowerCase() ? "own" :
                reviews?.has(String(pr.html_url).toLowerCase()) ? "review" :
                author && login && reviews ? "other" : "unknown" };
            } catch { result[id] = { relationship: "unknown" }; }
          }));
        }
      }
      cache = { signature, expires: Date.now() + 5 * 60_000, result };
      return result;
    })();
    pending = { signature, promise };
    void promise.finally(() => { if (pending?.promise === promise) pending = undefined; });
    return promise;
  };
}


/** Update only metadata, never diffs, revisions, comments or analysis jobs. */
export function persistPrPeople(keys: PrKey[], people: Record<string, PrPerson>, root: string): void {
  for (const key of keys) {
    const person = people[keyToString(key)];
    if (!person) continue;
    try {
      // A PR may have been deleted while its GitHub requests were in flight.
      const meta = readMeta(key, root);
      const patch: Partial<Meta> = {};
      if (person.author !== undefined && person.author !== meta.author) patch.author = person.author;
      if (person.authorAvatarUrl !== undefined && person.authorAvatarUrl !== meta.authorAvatarUrl) patch.authorAvatarUrl = person.authorAvatarUrl;
      if (person.relationship !== "unknown" && person.relationship !== meta.reviewRelationship) patch.reviewRelationship = person.relationship;
      if (person.title !== undefined && person.title !== meta.title) patch.title = person.title;
      if (person.state !== undefined && person.state !== meta.prState) patch.prState = person.state;
      if (person.reviewDecision !== undefined && person.reviewDecision !== meta.reviewDecision) patch.reviewDecision = person.reviewDecision;
      if (Object.keys(patch).length) updateMeta(key, patch, root);
    } catch { /* Never recreate removed PRs or break the dashboard on a missing record. */ }
  }
}
