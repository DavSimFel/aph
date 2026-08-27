# The aph change workflow

Every aph change moves from operator intent to production through this workflow. The operator's attention, time, and comprehension are the scarcest resource in the loop, so the workflow spends them on exactly three touches per unit of work: stating intent, approving the spec, and judging the delivered functionality. Agents do everything else — implementation, checks, code review, and every summary the operator reads.

Everything that reaches the operator is written for two-minute comprehension.

## Roles

| Role | Held by | Owns |
| --- | --- | --- |
| Operator | David | Intent, spec approval, session assignment, functionality verdicts, merge, promotion to `main` |
| Manager | A Claude session | Issue specs, roadmap order, review orchestration, stage labels, everything the operator reads |
| Implementer | An aph session | Implementation, targeted checks, the PR, responses to review findings |

The implementer and the reviewers are different systems: aph sessions implement and Claude-side agents review. An agent never judges its own work, so this split stays even once aph can review itself.

The operator never reads code, diffs, or the agent review trail. A change that forces the operator to is a workflow defect and gets its own issue.

## Roadmap

The roadmap is the GitHub issue list on this repository, with milestones as phases. There is no project board.

An issue is a brief sized for one aph session, and pasting its URL into a fresh session on the shipped `aph Implementer` preset is the complete briefing — the session receives nothing else. The preset's bundled `aph-issue-implementer` skill validates admission, isolates the work, and carries the issue through the draft-PR handoff. The body follows [templates/issue.md](templates/issue.md): **Intent** is the operator's acceptance test in the operator's own words, recorded before implementation starts, and the only thing the operator later reviews the PR against; **Context** points into the repository and prior issues; **Non-goals** bound the work; **Verification** names how a reviewer demonstrates the result.

The manager writes each issue from raw operator intent and labels it `stage/spec`. Operator approval moves it to `stage/ready`. The operator assigns work by pasting the issue into an aph session; the assignment is recorded as an issue comment naming the session, and the label moves to `stage/in-session`.

[`scripts/aph-issue-session.ts`](../scripts/aph-issue-session.ts) admits, claims, and publishes implementation work. The approved issue body and owner-authored amendments are the only task instructions; public comments and state-record comments never enter the briefing. A claim creates `origin/aph-claims/issue-<number>` without force before commenting or changing the stage, binding the issue to `DSH_SESSION_ID`. The implementation worktree lives under the development checkout's locally excluded `.aph-worktrees/` directory, which stays writable under the default `workspace-write` policy. Claim and publication steps reconcile their existing remote state after restart instead of duplicating comments or PRs.

Stage labels live on the issue only, and the manager owns the stage policy and any corrective transition. The implementer performs the two normal transitions attached to its work: the repository coordinator moves `stage/ready` to `stage/in-session` only after its atomic remote claim succeeds, then moves `stage/in-session` to `stage/agent-review` only after the draft PR exists and is linked. The manager performs `stage/spec` → `stage/ready`, manages the review loop, and moves an accepted draft to `stage/operator-review`. `stage/spec` and `stage/operator-review` are the only states that wait on the operator.

## Pull requests

A PR body starts with a **For the operator** section and puts nothing above it, per [templates/pr.md](templates/pr.md): the issue link with a one-sentence intent, what changed in behavior terms, the exact command or URL that shows it working, every decision the implementer made beyond the issue, and risk with rollback. Implementation notes, checks run, and the review trail sit below it in a collapsed section.

Agents open PRs with `gh pr create --body-file` over the template, so upstream's `.github/pull_request_template.md` stays unedited per [the additive rule](../APH.md#the-additive-rule).

Implementer commits use the repository's configured `user.name` and `user.email`; the issue assignment comment containing `DSH_SESSION_ID` attributes the implementation session. Implementers do not invent a model identity or add an automated co-author trailer.

The **For the operator** section is the implementer describing its own work, so review audits it like code: a claim the diff does not support, or an omitted decision, is a finding.

## Review

1. The implementer runs the checks that cover the diff and opens a draft PR in the required shape.
2. The manager runs the agent review loop: adversarial code review plus the aph gates — additive-rule compliance, the [decision-record obligation](../APH.md#where-aph-decisions-are-recorded), real check evidence, and the accuracy of the **For the operator** section. Findings land as PR comments, the implementer fixes, and the loop repeats until no finding remains. The operator sees none of it.
3. The manager verifies the PR against the issue's Intent, exercises the demonstration itself where possible, marks the PR ready, and pings the operator with a digest of at most ten lines.
4. The operator reads the **For the operator** section, exercises the functionality, and gives a verdict. On a pass, the operator merges. On a miss, the operator sends the manager one sentence; the manager translates it into findings and reenters step 2. The operator never explains the same miss twice.

Promotion from `dev` to `main` and `make install` remain a separate batched operator action, unchanged from [APH.md](../APH.md#branches).
