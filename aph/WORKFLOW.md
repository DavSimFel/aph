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

[`scripts/aph-issue-session.ts`](../scripts/aph-issue-session.ts) admits, claims, and publishes implementation work. Admission requires the authenticated `DavSimFel` GitHub identity. The approved issue body plus owner-authored amendments after the claim's unique assignment record in GitHub's canonical comment order are the only task instructions; same-second later amendments remain valid, while earlier owner comments, public comments, and state records never enter the briefing. The body has one authoritative `## Dependencies` section containing `- None` or exact repository issue and pull request URLs, and comments cannot add or change dependencies. Local ownership is atomically recorded before branch creation. The locally excluded `.aph-worktrees/` root, shared store, and issue worktree must be real directories physically contained by the development checkout; link-shaped paths are rejected before publication. Every recovery proves fresh-worktree cleanliness or claimed-base ancestry before rerunning the frozen worktree-local pnpm install, giving each accepted session separate writable dependency links while repairing partial state through the contained shared content store. A claim creates `origin/aph-claims/issue-<number>` without force before commenting or changing the stage, binding the issue to `DSH_SESSION_ID`, branch, worktree, and base commit. A lost or ambiguous race removes its provisional local state unless the complete remote claim exactly matches it. Claimed work resumes from its recorded base with dirty files or later commits intact even after `origin/dev` advances; local claim and publication steps reconcile incomplete durable state after restart instead of duplicating ownership, comments, or PRs. [Issue-session reconciliation](issue-session-reconciliation.md) records why these checks and ordering rules belong in the coordinator.

Stage labels live on the issue only, and the manager owns the stage policy and any corrective transition. The implementer performs the two normal transitions attached to its work: the repository coordinator moves `stage/ready` to `stage/in-session` only after its atomic remote claim succeeds, then moves `stage/in-session` to `stage/agent-review` only after the draft PR has the requested title and validated body, exactly one requested `kind/*` label and every requested `area/*` label, and a verified issue link. The manager performs `stage/spec` → `stage/ready`, manages the review loop, and moves an accepted draft to `stage/operator-review`. `stage/spec` and `stage/operator-review` are the only states that wait on the operator.

## Pull requests

A PR body starts with a **For the operator** section and puts nothing above it, per [templates/pr.md](templates/pr.md): the visible exact issue link with a one-sentence intent, what changed in behavior terms, one executable command or absolute URL that shows it working, every issue **Verification** item paired with the command or URL that item names and a concrete observed result, every decision beyond the issue, and risk with rollback. The exact collapsed section records the commands actually run and their observed results with the implementation notes and review trail.

Agents open PRs with `gh pr create --body-file` over the template, so upstream's `.github/pull_request_template.md` stays unedited per [the additive rule](../APH.md#the-additive-rule).

Implementer commits use the repository's configured `user.name` and `user.email`; the issue assignment comment containing `DSH_SESSION_ID` attributes the implementation session. Implementers do not invent a model identity or add an automated co-author trailer.

The **For the operator** section is the implementer describing its own work, so review audits it like code: a claim the diff does not support, or an omitted decision, is a finding.

## Review

1. The implementer runs the checks that cover the diff and opens a draft PR in the required shape.
2. The manager runs the agent review loop: adversarial code review plus the aph gates — additive-rule compliance, the [decision-record obligation](../APH.md#where-aph-decisions-are-recorded), real check evidence, and the accuracy of the **For the operator** section. Findings land as PR comments, the implementer fixes, and the loop repeats until no finding remains. The operator sees none of it.
3. The manager verifies the PR against the issue's Intent, exercises the demonstration itself where possible, marks the PR ready, and pings the operator with a digest of at most ten lines.
4. The operator reads the **For the operator** section, exercises the functionality, and gives a verdict. On a pass, the operator merges. On a miss, the operator sends the manager one sentence; the manager translates it into findings and reenters step 2. The operator never explains the same miss twice.

Promotion from `dev` to `main` and `make install` remain a separate batched operator action, unchanged from [APH.md](../APH.md#branches).
