# Issue-session reconciliation

The aph implementer crosses local files, Git worktrees and refs, GitHub comments and labels, pnpm state, and a draft pull request. These systems do not share a transaction. A process can stop after any durable mutation, and two sessions can race for one issue, so the coordinator returns success only after it re-reads the durable state that proves the requested outcome.

## Admission and briefing trust

[`scripts/aph-issue-session.ts`](../scripts/aph-issue-session.ts) owns admission, claiming, and handoff. Admission requires the authenticated GitHub login `DavSimFel`, the expected repository, an equivalent canonical origin URL, the approved issue author and stage, and resolved dependencies from the body’s mandatory section.

The issue body is the approved briefing. The unique assignment comment for the current session is the ordering boundary for amendments. GitHub’s returned comment order decides which comments are later, including comments with the same second-resolution timestamp; timestamps must remain monotonic so a malformed response cannot silently reorder instructions. Only later owner-authored non-state comments enter the briefing.

## Local state and dependency repair

Local ownership is published without clobbering before branch creation. `.aph-worktrees`, its pnpm store, and each issue worktree must be real directories that physically resolve inside the task checkout. Link-shaped owner and dependency records are rejected, and link-shaped dependency directories are unlinked rather than traversed.

A recovered worktree must first prove the expected branch and path. An unclaimed worktree must be clean at its recorded base; a claimed worktree’s recorded base must be an ancestor of its current head. Only accepted worktree state may run the frozen pnpm install. Every accepted recovery repeats that install through the contained shared store, allowing pnpm to repair partial or manifest-changing state without trusting a completion marker.

## Exclusive claims and failure preservation

The no-force `origin/aph-claims/issue-<number>` ref is the exclusive cross-clone reservation. Provisional local state is retained only when the complete observed claim matches the issue, session id, branch, physical worktree path, and base. Every lost or ambiguous race independently attempts worktree, branch, owner-record, and dependency-record cleanup.

When a Git fetch or push fails, a follow-up remote-state probe may determine whether the operation lost a race or merely returned an ambiguous response. If that probe also fails, the original Git error remains first and the probe failure is secondary in an `AggregateError`. Cleanup follows the same rule: diagnostic work must not replace the failure that caused it.

## Publication conformance

Handoff reads the requested PR body once and validates its operator fields, issue link, executable demonstration, per-requirement evidence, rollback statement, and recorded check commands. An existing PR is eligible for repair only while it remains an open draft from the issue branch to `dev`. Title, body, and classification labels are reconciled and re-read before the issue receives its PR link or moves to `stage/agent-review`.

The coordinator enforces syntax and durable publication state; independent manager review still judges whether prose, labels, demonstrations, and claimed results are semantically accurate.

## Rejected alternatives

Model instructions alone cannot make a race atomic or prevent an omitted field from reaching review, so enforceable lifecycle and publication requirements live in the coordinator. A sibling worktree would require wider permission than Workspace Write, so physically verified storage stays below the checkout. A dependency completion marker cannot prove that a later interrupted install completed after manifest changes, so accepted recovery repeats the frozen install. Comments written before assignment may describe abandoned planning, so they are not implementation instructions.

This design assumes ordinary concurrent filesystem activity. It does not claim protection from a hostile process replacing paths between asynchronous checks.
