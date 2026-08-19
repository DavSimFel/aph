# APH.md

Autopoiesis (`aph`) is a self-maintaining personal agent OS built as an additive layer over a fork of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). The harness improves itself, so the seam between upstream code and aph code has to stay legible to both the person and the agent reading their own diff.

[AGENTS.md](AGENTS.md) is upstream's and remains authoritative for everything it covers — architecture, capability seams, testing policy, prose standards. This file adds only what is true of the fork. Where the two conflict, this file wins for aph-owned files and AGENTS.md wins everywhere else.

## The additive rule

The fork stays mergeable with `upstream/master` and syncs regularly, so **every aph change is a new file wherever a new file can do the job**: a new plugin package, a new bundle patch layer, a new agent preset, a new workflow, a new `make` target. Each upstream file aph edits becomes a merge conflict on every future sync, forever.

Editing an upstream file is allowed but is the exception, and the PR says why the additive path was not available.

The architecture cooperates with this. Cordis composes everything from patch layers, so behavior is added by mounting a row or overriding one by id — never by editing the plugin it configures. Three seams carry most aph work: profile bundles in `packages/bundle/`, agent presets under `$DSH_HOME/.agent-presets`, and a profile's own `cordis.patch.yml`.

## Branches

| Branch | Role |
| --- | --- |
| `upstream` | Mirror of deepseek-harness `master`. Fast-forward only; never holds aph code. |
| `dev` | Integration and the repository default. All work lands here by PR. |
| `main` | Production. `make install` deploys `origin/main` as fetched. |

Work branches off `dev` and returns by PR. `main` advances only by promotion from `dev`. Upstream syncs enter through `make sync-upstream`, which fast-forwards `upstream` and opens a sync branch that reaches `dev` as an ordinary PR.

## What CI runs

Upstream's workflows carry two kinds of trigger and the fork meets them differently.

Every `push:` trigger names `master`, a branch that does not exist here, so those lanes are dormant: `ci.yml`, `docs-pages.yml`, `release.yml`, `release-vendor.yml`, `landlock-run.yml`, and `sandbox.yml` never run on a push to an aph branch. Ten workflows also carry a `pull_request:` trigger with no branch filter, and an unfiltered trigger fires whatever the base branch is, so those run on every aph pull request: the Node 22.19 and 26 compatibility jobs, the Python SDK and runtime jobs, the Wine-hosted Windows gates, the path-filtered native landlock builds, and npm packing.

**Upstream's three Linux enterprise jobs cannot run here.** `ci.yml` pins its static, coverage, and snapshot jobs to the `dsh-ubuntu-24-04-16core` pool and its native Windows job to `dsh-windows-2025-16core`. Those labels belong to the upstream organization; this repository has no runner carrying them, so the jobs queue until they expire, reporting neither success nor failure. [aph-ci.yml](.github/workflows/aph-ci.yml) runs the same three gate suites — `check:ci:static`, `check:ci:coverage`, `check:ci:snapshot` — on GitHub-hosted runners instead. It is a new file rather than an edit to `ci.yml` because upstream owns that file and every edit to it returns as a conflict on each sync.

aph-ci.yml also triggers on pushes to `dev` and `main`, which is the only post-merge evidence either branch gets. Of upstream's workflows, none run on a push to `dev`, and on a push to `main` only [e2e.yml](.github/workflows/e2e.yml) runs, self-skipping without `DEEPSEEK_API_KEY`.

`issue-policy.yml` and `issue-lifecycle.yml` are **disabled on this repository**. [config.json](.github/issue-management/config.json) pins `organization` to a fixed value, so on the fork the policy script asks GitHub about a pull request in a repository that does not exist and exits non-zero; they also enforce upstream's issue conventions rather than the ones in [aph/WORKFLOW.md](aph/WORKFLOW.md). Disabling is a repository setting rather than a file change, so it survives every sync and reverses from the Actions tab.

## Environments

Both environments run on the local machine and are reached through a Cloudflare tunnel; the tunnel is configured outside this repository.

| | Production | Development |
| --- | --- | --- |
| Branch | `origin/main`, as fetched | the working tree |
| Domain | `autopoiesis.feldhofer.cc` | `staging-autopoiesis.feldhofer.cc` |
| Checkout | `~/.local/share/aph` | this repository |
| State root | `~/.aph` | `./.aph` (git-ignored) |
| Port | 16720 | 16721 |
| Command | `make serve` | `make dev` |

The ports are the ones `~/.cloudflared/config.yml` already routes to, so the tunnel needs no change. Both are currently served by an older `dsaph` deployment out of `/run/user/1000/`. Taking them over is a manual cutover of a running system, so `make` refuses a busy port rather than competing for it and names the override; `make doctor` reports which ports are free.

State roots are separate per deployment: production `~/.aph`, the staging service `~/.aph-staging`, and the interactive `make dev` server `./.aph` in this checkout. Nothing a dev run writes can reach production sessions, settings, or credentials.

The state roots are separate so a dev session can never write production sessions, settings, or credentials. Both are set through `DSH_HOME`, which the harness already treats as configurable, so no source change is involved.

**The bind host is always loopback.** The web startup rejects `--host 0.0.0.0` outright because it would expose remote code execution to the network ([startup.ts](packages/bundle/web-app/src/startup.ts)). The tunnel is the only ingress, and authentication belongs to Cloudflare Zero Trust in front of it — never to a hand-rolled check inside the harness.

**Serving needs `--trusted-host`.** Requests arrive from cloudflared carrying the public Host header, which the browser-trust fence refuses unless the authority is declared, so every `/api` call would 403 without it. Declaring the authority is the fence's own config seam rather than a weakening of it: the fence defends DNS rebinding, and an attacker cannot make `feldhofer.cc` resolve to this machine's loopback without controlling that DNS. `make serve` and `make dev` pass it; an undeclared authority is still refused.

## The configuration plane is loopback-only

A set of methods stays pinned to loopback even on a trusted-host deployment — `settings.*`, `credentials.*`, `llm.discoverModels`, agent-preset management, and the native host dialogs ([client/connection](packages/client/connection/src/index.ts)). Reads are pinned with writes, because `settings.describe` returns every exposed namespace and `credentials.describe` reports whether a named variable is configured. Over the tunnel these answer 403; the model picker is unaffected, since `llm.providers` and `llm.models` are deliberately excluded from the pin.

This is upstream's decision and aph keeps it. `trustedHosts` is a DNS-rebinding fence and upstream states it is explicitly not authentication, so the configuration plane waits for a real authentication layer. Cloudflare Access is one, but the harness cannot see it, and the only sound way to teach the fence would be verifying a signed `CF_Authorization` JWT — trusting a `Cf-Access-Authenticated-User-Email` header would be spoofable by anything that reaches the origin. That belongs upstream as an extension point, not in the fork as a policy.

Replacing the connection row by id to drop the pin is specifically rejected. It reads as the additive path, but it would make aph the silent owner of a list upstream actively curates, so a later upstream addition would leave a method unpinned that nobody here evaluated.

The cost is smaller than it looks: the configuration plane is file-backed. Settings are `$DSH_HOME/settings.yaml`, re-read on change ([settings-file](packages/settings/settings-file/src/index.ts)), and credentials resolve from the environment and `.env`. Configuring providers and keys means editing files the harness already watches, over SSH or through the agent itself. The 403 costs a pane, not a capability.

## Devops is make

[Makefile](Makefile) owns every deployment action. It has no upstream counterpart, so it never conflicts on a sync — which is exactly why devops lives there rather than in the root `package.json`, whose scripts belong to deepseek-harness. Run `make help` for the current targets.

`make install` deploys `origin/main` as fetched into a detached worktree, never the working tree, so an experimental checkout cannot silently become production.

## Where aph decisions are recorded

Upstream requires an Agent Note in `.agents/notes/` for every non-trivial change. aph does not add notes there. That tree is translation-paired (`.agents/notes/**/*.md` in [verify-translation-pairing.ts](scripts/verify-translation-pairing.ts)), so each note also demands a Chinese counterpart and a consistency record produced by a skill only the user may invoke, and every file aph added there would be fork divergence inside an upstream-owned directory.

aph decisions are recorded in aph-owned documentation instead — this file while it is small enough, and a dedicated aph docs tree once it is not. The obligation is unchanged: a non-trivial aph change still records what was decided and why. Only the location moves.

## The change workflow

Operator intent becomes a GitHub issue, an aph session implements it, agents review it, and the operator judges only the delivered functionality. [aph/WORKFLOW.md](aph/WORKFLOW.md) owns the roles, roadmap, stage labels, PR structure, and review sequence.

## Services

Both deployments run as systemd user units rendered from one template, [aph/systemd/aph-web.service.in](aph/systemd/aph-web.service.in). `make enable` renders and enables them, `make start` / `stop` / `restart` / `status` / `logs` drive them. Rendering resolves node to a real path and bind-mounts its installation prefix, because systemd starts the unit with no shell and `ProtectHome=tmpfs` would otherwise hide it.

`make install` deploys `origin/main` to `~/.local/share/aph` and `make install-staging` deploys `origin/dev` to `~/.local/share/aph-staging`, each as a detached worktree reset to the ref as fetched. Installing does not start anything; the unit does.

`make dev` serves the working tree on the staging port for interactive work, so it and the staging service cannot both hold it. The port guard reports the conflict rather than either one winning silently: stop the service to take the port, start it again to hand it back.

**A running deployment cannot modify its own code.** The unit bind-mounts the code tree read-only and leaves only the state root and the workspace writable. Self-improvement therefore runs through the branch flow — the system proposes a change as a PR to `dev`, and it reaches production by promotion and `make install` — never by a live process editing the source it is currently executing. This is the property that keeps autopoiesis reviewable, so a change that needs a writable code tree needs a different design, not a relaxed unit.

The units supersede the earlier `dsaph` deployment's `autopoiesis.service` and `autopoiesis-staging.service`, which are disabled. Their state under `~/.local/state/dsaph/` and `~/.local/share/dsaph/` is left in place. `autopoiesis-gateway.service` and `autopoiesis-prototype.service` are unrelated services on other ports and are untouched.
