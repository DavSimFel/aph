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

Upstream's GitHub workflows all trigger on `master`, a branch that no longer exists, so they are dormant rather than deleted. aph CI arrives as new workflow files targeting `dev` and `main`. The exception is [e2e.yml](.github/workflows/e2e.yml), which triggers on `main` and self-skips without `DEEPSEEK_API_KEY`.

## Environments

Both environments run on the local machine and are reached through a Cloudflare tunnel; the tunnel is configured outside this repository.

| | Production | Development |
| --- | --- | --- |
| Branch | `origin/main`, as fetched | the working tree |
| Domain | `autopoiesis.feldhofer.cc` | `staging-autopoiesis.feldhofer.cc` |
| Checkout | `~/.local/share/aph` | this repository |
| State root | `~/.aph` | `./.aph` (git-ignored) |
| Port | 3080 | 3081 |
| Command | `make serve` | `make dev` |

The state roots are separate so a dev session can never write production sessions, settings, or credentials. Both are set through `DSH_HOME`, which the harness already treats as configurable, so no source change is involved.

**The bind host is always loopback.** The web startup rejects `--host 0.0.0.0` outright because it would expose remote code execution to the network ([startup.ts](packages/bundle/web-app/src/startup.ts)). The tunnel is the only ingress, and authentication belongs to Cloudflare Zero Trust in front of it — never to a hand-rolled check inside the harness.

## Devops is make

[Makefile](Makefile) owns every deployment action. It has no upstream counterpart, so it never conflicts on a sync — which is exactly why devops lives there rather than in the root `package.json`, whose scripts belong to deepseek-harness. Run `make help` for the current targets.

`make install` deploys `origin/main` as fetched into a detached worktree, never the working tree, so an experimental checkout cannot silently become production.

## Where aph decisions are recorded

Upstream requires an Agent Note in `.agents/notes/` for every non-trivial change. aph does not add notes there. That tree is translation-paired (`.agents/notes/**/*.md` in [verify-translation-pairing.ts](scripts/verify-translation-pairing.ts)), so each note also demands a Chinese counterpart and a consistency record produced by a skill only the user may invoke, and every file aph added there would be fork divergence inside an upstream-owned directory.

aph decisions are recorded in aph-owned documentation instead — this file while it is small enough, and a dedicated aph docs tree once it is not. The obligation is unchanged: a non-trivial aph change still records what was decided and why. Only the location moves.
