# Agent Note: aph issue sessions use verified durable reconciliation

Status: implemented

English | [中文](2026-08-27-aph-issue-session-transaction.zh.md)

## Problem

One aph implementation session spans local files, Git worktrees and refs, GitHub comments and labels, pnpm state, and a draft pull request. These systems do not share a transaction. A process can stop after any durable mutation, two sessions can race for one issue, and a model can omit a publication requirement that prose alone cannot enforce. Recovery must distinguish proven ownership from provisional state without widening the default workspace permission.

The issue URL is the complete briefing, so admission also carries a trust obligation. The authenticated actor, approved body, assignment time, dependency state, and physical worktree location must be verified before their dependent mutations occur.

## Decision

[`scripts/aph-issue-session.ts`](../../../../scripts/aph-issue-session.ts) is the executable owner of admission, claiming, and handoff. Admission requires the `DavSimFel` authenticated GitHub login, the expected repository, an equivalent canonical origin URL, the approved issue author and stage, and resolved dependencies from the body's mandatory section. Only owner amendments strictly later than the unique assignment record for the current claim enter the briefing.

Local ownership is published without clobbering before branch creation. `.aph-worktrees`, its pnpm store, and every issue worktree must be real directories that physically resolve inside the task checkout; link-shaped owner and dependency records are rejected. Every recovery reruns the frozen pnpm install through the contained shared store, so a partial or manifest-changing install is repaired instead of trusted through a completion shortcut.

The no-force `origin/aph-claims/issue-<number>` ref is the exclusive cross-clone reservation. A session retains provisional local state only when the complete observed claim matches its issue, session id, branch, physical worktree path, and base. Every lost or ambiguous race attempts worktree, branch, owner, and dependency cleanup independently before returning the primary failure.

Handoff validates the exact body bytes read from the supplied file, requires an executable demonstration command or absolute URL, and requires evidence for every item in the issue's **Verification** section. It creates or reconciles the draft PR title and body, applies exactly one requested `kind/*` label plus the requested `area/*` labels, and re-reads the PR before linking it or moving the issue to `stage/agent-review`. Each step can be rerun after response loss or interruption.

## Alternatives considered

**Rely on the implementer skill for lifecycle and PR conformance.** Model instructions remain necessary for judgment, but they cannot make a race atomic or prevent an omitted label or evidence field from reaching review. Enforceable requirements therefore live in the coordinator.

**Place issue worktrees beside the checkout.** A sibling path requires wider permission than a normal Workspace Write session. A physically verified, locally excluded child directory preserves the default confinement.

**Skip dependency installation after a completion marker.** A marker keyed to the original base becomes stale after manifest or lockfile changes and cannot prove that an interrupted later install completed. Repeating the frozen install is slower but gives pnpm the chance to repair its own state from the shared content store.

**Trust all owner comments.** Owner comments written before assignment were not part of the assigned briefing and can reflect abandoned planning. The assignment record is the durable ordering boundary for amendments.

## Consequences

- Claim and handoff retries perform extra GitHub reads and pnpm work, but every returned success is based on observed durable state.
- A link or junction anywhere in coordinator-owned worktree storage blocks the session before publication rather than being followed.
- Ambiguous remote-claim outcomes may remove a local worktree even when the push actually won; the immutable remote claim lets the same session recreate it safely on retry.
- PR classification and evidence omissions fail while the issue remains `stage/in-session`; semantic completeness of chosen area labels and evidence remains an independent manager-review responsibility.
