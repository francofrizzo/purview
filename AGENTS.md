# Agent guidance

## Verification and evidence

Before calling a behavior change complete, exercise the changed behavior in the
running application and capture proof. Passing lint, build, or tests alone is
insufficient.

Documentation-only and other changes with no runtime effect require checking the
changed content and references, but no live application run or screenshots.

### Verify the behavior

1. Define observable acceptance criteria for the change. Use safe fixtures and the
   startup/setup instructions in [README.md](README.md). For UI-only behavior, the
   documented mock mode is suitable; API, persistence, and integration changes
   require the real server or CLI. Record any mocked dependencies and the limits
   they place on the result.
2. Run applicable lint, build, and test scripts separately, using pnpm and the
   scripts defined in the root and affected packages' `package.json` files. Record
   results and unavailable checks; a missing script is not a passing check.
3. Exercise each acceptance criterion and capture the evidence below. Inspect
   screenshots, play back videos, and read captured output before judging the
   result. After relevant code changes, repeat the affected checks and live
   verification so the evidence matches the final code.
4. When sub-agents are available, use a fresh verifier with acceptance criteria,
   setup instructions, and the source revision. The verifier independently drives
   the application and reports observations and evidence without editing source
   code; fixture interactions and evidence capture are allowed. Resolve failures
   and repeat affected verification. If unavailable, record that limitation.

| Change | Required evidence |
| --- | --- |
| Static UI state | Screenshots of the actual running screen. |
| Motion, transitions, transient states, multistep flows, or requested demos | Video plus one final-state screenshot; additional screenshots only for states the video does not adequately show. |
| Node APIs, jobs, CLI, or data flows | Trigger the real endpoint, job, or command; capture responses, relevant logs, or resulting persisted state. |
| Bug fix | Demonstrate failure before and success after where feasible; explain when the before case cannot be reproduced. |
| Performance | Comparable before/after measurements with the same workload and environment. |

### Record the run

Save artifacts in the gitignored repository-root directory
`evidence/<task>-<timestamp>/`. Use this single location for all capture tools.
Each run includes a short `RUN.md` containing:

- Goal and observable acceptance criteria.
- Source revision and uncommitted changes, environment, and fixture/setup details.
- Commands and interaction steps, expected results, and actual observations.
- Relative links to screenshots, video, and captured output.
- Verdict: `works`, `broken`, or `not verified`.
- Cases not exercised, blockers, and verifier findings or unavailability.

Use `works` only when the acceptance criteria have been exercised successfully
and the inspected evidence supports them. Use `broken` for observed failures and
`not verified` when missing evidence or blockers prevent a conclusion. In the
final response, include the verdict, evidence links, and material limitations.

### Publish PR evidence

When creating or updating a PR, fill its Evidence section with the verdict,
reproduction steps, checks, limitations, and reviewer-accessible artifact links.
Upload screenshots and videos with `gh pr create --attach` or
`gh pr edit --attach` (repeat the flag for each file); GitHub hosts the files and
embeds them in the PR body. Include short text output directly or link a captured
log. Verify those links before claiming the evidence is published. Local paths alone
are insufficient; report a publishing blocker if artifacts cannot be shared.

Use safe fixtures. Inspect artifacts for secrets and real customer data before
publishing; redact sensitive content or recapture with sanitized fixtures.
