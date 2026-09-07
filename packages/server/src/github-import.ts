import { gh } from "@reviewer/core";
import { z } from "zod";

export const ImportScopeSchema = z.enum(["all", "created", "assigned", "review-requested"]);
export type ImportScope = z.infer<typeof ImportScopeSchema>;

const qualifiers = {
  created: "author",
  assigned: "assignee",
  "review-requested": "review-requested",
} as const;

const SearchPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(z.object({ html_url: z.string().url() })),
});

/** Search the open-PR dashboard scopes using the github.com gh identity. */
export function discoverPullRequests(scope: ImportScope) {
  const { login } = z.object({ login: z.string().regex(/^[a-zA-Z0-9-]+$/) }).parse(
    JSON.parse(gh(["api", "--hostname", "github.com", "user"])),
  );
  const scopes = scope === "all" ? Object.keys(qualifiers) as (keyof typeof qualifiers)[] : [scope];
  const urls = new Set<string>();
  const warnings: string[] = [];
  for (const selected of scopes) {
    const query = `is:pr is:open ${qualifiers[selected]}:${login}`;
    // GitHub search exposes at most 1,000 matches per query. Surface limits
    // and timeouts rather than claiming that a partial import included all PRs.
    for (let page = 1; page <= 10; page++) {
      const result = SearchPageSchema.parse(JSON.parse(gh([
        "api", "--hostname", "github.com", "--method", "GET", "search/issues",
        "-f", `q=${query}`, "-f", "sort=created", "-f", "order=asc",
        "-F", "per_page=100", "-F", `page=${page}`,
      ])));
      for (const item of result.items) urls.add(item.html_url);
      if (result.incomplete_results) warnings.push(`${selected}: GitHub returned incomplete search results. Try importing again.`);
      if (page === 1 && result.total_count > 1000) {
        warnings.push(`${selected}: GitHub limits search to 1,000 results; some PRs were not imported.`);
      }
      if (page * 100 >= result.total_count || result.items.length < 100) break;
    }
  }
  return { login, urls: [...urls], warnings: [...new Set(warnings)] };
}
