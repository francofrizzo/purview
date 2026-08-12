import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MOCK } from "../api/client";
import { useAddPr, usePrs } from "../api/hooks";
import { AnalysisChip } from "../components/Analysis";
import { Progress } from "../components/Chips";
import { IconSettings } from "../components/icons";

export function PrList() {
  const { data: prs = [], isLoading, error } = usePrs();
  const addPr = useAddPr();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    addPr.mutate(value, {
      onSuccess: (entry) => {
        setUrl("");
        if (entry?.key) navigate(`/pr/${entry.key}`);
      },
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-10">
      <header className="mb-6 flex items-start">
        <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight">Reviewer</h1>
        <p className="mt-0.5 text-xs" style={{ color: "var(--fg-muted)" }}>
          Local-first pull request review.{" "}
          {MOCK ? (
            <span style={{ color: "var(--warn)" }}>mock mode — no server, fixture data</span>
          ) : (
            <span>talking to localhost:4779</span>
          )}
        </p>
        </div>
        <Link to="/settings" className="btn flex-none" title="Settings">
          <IconSettings width={12} height={12} />
          settings
        </Link>
      </header>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          className="input font-mono text-xs"
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="btn btn-primary flex-none" disabled={addPr.isPending}>
          {addPr.isPending ? "fetching…" : "add PR"}
        </button>
      </form>

      {addPr.error ? (
        <div className="mb-4 rounded px-3 py-2 text-xs" style={{ background: "var(--risk-soft)", color: "var(--risk)" }}>
          {(addPr.error as Error).message}
        </div>
      ) : null}

      <div className="surface min-h-0 flex-1 overflow-auto rounded-md">
        {isLoading ? (
          <p className="p-4 text-xs" style={{ color: "var(--fg-faint)" }}>
            Loading…
          </p>
        ) : error ? (
          <p className="p-4 text-xs" style={{ color: "var(--risk)" }}>
            {(error as Error).message}
          </p>
        ) : prs.length === 0 ? (
          <p className="p-4 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
            No pull requests tracked yet. Paste a GitHub PR URL above; the server fetches it with{" "}
            <span className="font-mono">gh</span> and creates the local state directory.
          </p>
        ) : (
          <ul>
            {prs.map((pr) => {
              const meta = pr.meta ?? ({} as (typeof pr)["meta"]);
              return (
                <li key={pr.key} className="border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
                  <Link
                    to={`/pr/${pr.key}`}
                    className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium">
                          {pr.title ?? meta?.title ?? pr.key}
                        </span>
                        <AnalysisChip job={pr.analysisJob} />
                      </div>
                      <div className="mt-0.5 font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
                        {meta?.owner ? `${meta.owner}/${meta.repo}#${meta.number}` : pr.key}
                        {pr.unitCount ? ` · ${pr.unitCount} units` : " · not analyzed"}
                      </div>
                    </div>
                    {pr.totalHunks ? (
                      <Progress viewed={pr.viewedHunks ?? 0} total={pr.totalHunks} />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
