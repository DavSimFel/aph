# Agent Note: aph issue session 使用经过验证的持久化对账

Status: implemented

[English](2026-08-27-aph-issue-session-transaction.md) | 中文

## 问题

一次 aph 实现 session 会跨越本地文件、Git worktree 与 ref、GitHub 评论与标签、pnpm 状态以及 draft pull request。这些系统不共享事务。进程可能在任意持久化变更后停止，两个 session 可能争抢同一个 issue，模型也可能遗漏仅由文字指引规定的发布要求。恢复过程必须区分已证明的所有权与临时状态，同时不能扩大默认工作区权限。

issue URL 是完整任务说明，因此准入还承担信任要求。经过认证的操作者、获批正文、分配时间、依赖状态和 worktree 的物理位置，都必须在依赖它们的变更之前完成验证。

## 决策

[`scripts/aph-issue-session.ts`](../../../../scripts/aph-issue-session.ts) 是准入、认领与交接的可执行所有者。准入要求经过认证的 GitHub 登录名为 `DavSimFel`，并验证目标仓库、等价的规范 origin URL、获批 issue 作者与阶段，以及正文必填章节中的已解决依赖。只有严格晚于当前 claim 唯一分配记录的 owner 修订才会进入任务说明。

本地所有权会在创建分支前以不可覆盖方式发布。`.aph-worktrees`、其中的 pnpm store 和每个 issue worktree 都必须是物理解析到任务 checkout 内部的真实目录；link 形式的所有者记录和依赖记录会被拒绝。每次恢复都会通过受约束的共享 store 重新运行 frozen pnpm install，因此局部完成或 manifest 变化后的安装会被修复，而不会由完成标记直接判定为可信。

不使用 force 的 `origin/aph-claims/issue-<number>` ref 是跨 clone 的排他 reservation。只有观测到的完整 claim 与 issue、session id、分支、物理 worktree 路径和 base 全部一致时，session 才会保留临时本地状态。每次失败或结果不明的竞争都会独立尝试清理 worktree、分支、所有者记录和依赖状态，然后再返回主要失败。

交接会验证从给定文件读取的精确正文，要求一个可执行演示命令或绝对 URL，并要求为 issue 的每个 **Verification** 条目提供证据。它会创建或对账 draft PR 的标题和正文，应用恰好一个请求的 `kind/*` 标签以及所有请求的 `area/*` 标签，并在链接 PR 或把 issue 移到 `stage/agent-review` 之前重新读取 PR。响应丢失或中断后，每一步都可以重新运行。

## 考虑过的替代方案

**依赖 implementer skill 保证生命周期与 PR 合规。** 模型指引仍然承担判断工作，但无法让竞争具备原子性，也无法阻止遗漏标签或证据字段的 PR 进入 review。因此，可执行要求归 coordinator 所有。

**把 issue worktree 放在 checkout 旁边。** 兄弟路径要求比普通 Workspace Write session 更宽的权限。经过物理验证且仅在本地排除的子目录可以保留默认约束。

**在完成标记存在时跳过依赖安装。** 只绑定原始 base 的标记会在 manifest 或 lockfile 改变后失效，也无法证明后来中断的安装已经完成。重复执行 frozen install 会更慢，但能让 pnpm 利用共享内容 store 修复自己的状态。

**信任所有 owner 评论。** 分配前写下的 owner 评论不属于已分配任务说明，也可能来自已经放弃的规划。分配记录是修订的持久化顺序边界。

## 后果

- claim 与 handoff 重试会增加 GitHub 读取和 pnpm 工作，但每个成功结果都以观测到的持久化状态为依据。
- coordinator 自有 worktree 存储中的任何 link 或 junction 都会在发布前阻断 session，而不会被跟随。
- 结果不明的远程 claim 可能在 push 实际成功时仍移除本地 worktree；不可变远程 claim 允许同一 session 在重试时安全重建它。
- PR 分类和证据遗漏会在 issue 仍处于 `stage/in-session` 时失败；所选 area 标签和证据在语义上是否完整，仍由独立 manager review 判断。
