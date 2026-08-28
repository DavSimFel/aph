<!-- Body template for aph PRs. Agents apply it with `gh pr create --body-file`; nothing goes above "For the operator". -->

## For the operator

**Intent:** Fixes #NN — one sentence.

**What changed:** Behavior, not files.

**See it working:** One exact executable command or absolute URL; no setup left to the reader.

**Verification evidence:** Repeat every issue **Verification** item as `- <exact item> — <the command or absolute URL named by that item> → <concrete observed result>`; if the item names neither, use the demonstrator that proves it.

**Decisions not in the issue:** Every judgment call beyond the spec, or "none".

**Risk & rollback:**

<details>
<summary>Implementation notes, checks, review trail</summary>

- Checks run:
  - `<exact command>` → <observed result>
- Notes:

</details>
