#!/usr/bin/env -S pnpm exec tsx

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, link, lstat, mkdir, open, readFile, realpath, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 as pathWin32 } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const REPOSITORY = 'DavSimFel/aph'
const OWNER = 'DavSimFel'
const STATE_COMMENT_PREFIXES = ['Assigned to DSH session `', 'Draft implementation PR: ']
const CLAIM_MESSAGE_HEADER = 'APH_ISSUE_CLAIM_V1'

type CommandRunner = typeof run
type Stage = 'stage/ready' | 'stage/in-session' | 'stage/agent-review'

interface IssueComment {
  readonly author: { readonly login: string }
  readonly authorAssociation: string
  readonly body: string
  readonly createdAt: string
}

interface IssueRecord {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly url: string
  readonly author: { readonly login: string }
  readonly labels: readonly { readonly name: string }[]
  readonly comments: readonly IssueComment[]
}

interface ClaimRecord {
  readonly issue: number
  readonly sessionId: string
  readonly branch: string
  readonly worktree: string
  readonly base: string
}

interface WorktreeRecord {
  readonly path: string
  readonly branch: string
  readonly base: string
  readonly created: boolean
}

interface PullRequestRecord {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly body: string
  readonly state: string
  readonly isDraft: boolean
  readonly baseRefName: string
  readonly headRefName: string
  readonly labels: readonly { readonly name: string }[]
}

interface DependencyRecord {
  readonly url: string
  readonly kind: 'issue' | 'pull-request'
  readonly closed: boolean
  readonly merged: boolean
}

interface ApprovedIssue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly url: string
  readonly author: { readonly login: string }
  readonly labels: readonly { readonly name: string }[]
}

interface AdmissionResult {
  readonly issue: ApprovedIssue
  readonly stage: Stage
  readonly claim: ClaimRecord | undefined
  readonly dependencies: readonly string[]
  readonly trustedAmendments: readonly string[]
  readonly ignoredCommentCount: number
}

/** Host operations used by the implementer session coordinator. */
export interface IssueSessionAdapter {
  verifyRepository(): Promise<void>
  readIssue(number: number): Promise<IssueRecord>
  readClaim(number: number): Promise<ClaimRecord | undefined>
  readDependency(url: string): Promise<DependencyRecord>
  ensureWorktree(number: number, sessionId: string, claim: ClaimRecord | undefined): Promise<WorktreeRecord>
  removeWorktree(worktree: WorktreeRecord): Promise<void>
  tryCreateClaim(claim: ClaimRecord): Promise<boolean>
  addIssueComment(number: number, body: string): Promise<void>
  setIssueStage(number: number, from: Stage, to: Stage): Promise<void>
  findPullRequest(branch: string): Promise<PullRequestRecord | undefined>
  createPullRequest(branch: string, title: string, body: string): Promise<PullRequestRecord>
  updatePullRequest(number: number, title: string, body: string): Promise<void>
  setPullRequestLabels(number: number, labels: readonly string[]): Promise<void>
}

/** Admission input shared by inspection and mutation commands. */
export interface AdmissionInput {
  readonly issueUrl: string
  readonly sessionId: string
}

/** Claim result returned to the agent before implementation begins. */
export interface ClaimResult extends AdmissionResult {
  readonly worktree: WorktreeRecord
}

/** Publication input for an idempotent draft-PR handoff. */
export interface HandoffInput extends AdmissionInput {
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
}

/** Publication result after the issue reaches agent review. */
export interface HandoffResult {
  readonly issue: number
  readonly pullRequest: PullRequestRecord
  readonly stage: 'stage/agent-review'
}

/** Coordinate trusted admission, exclusive claiming, and restart-safe publication. */
export class IssueSessionCoordinator {
  constructor(private readonly adapter: IssueSessionAdapter) {}

  /**
   * Validate one issue without mutating Git, GitHub, or the worktree.
   * @param input - issue URL and current session identity.
   * @returns the approved briefing and resumable state.
   */
  async inspect(input: AdmissionInput): Promise<AdmissionResult> {
    const number = parseIssueUrl(input.issueUrl)
    requireSessionId(input.sessionId)
    await this.adapter.verifyRepository()
    const [issue, claim] = await Promise.all([
      this.adapter.readIssue(number),
      this.adapter.readClaim(number),
    ])
    if (issue.url !== input.issueUrl || issue.number !== number) {
      throw new Error(`issue-session: GitHub returned a different issue for ${input.issueUrl}`)
    }
    if (issue.author.login !== OWNER) {
      throw new Error(`issue-session: issue #${number} must be authored by ${OWNER}`)
    }
    if (issue.state !== 'OPEN') throw new Error(`issue-session: issue #${number} is ${issue.state}, expected OPEN`)
    if (claim !== undefined && claim.sessionId !== input.sessionId) {
      throw new Error(`issue-session: issue #${number} is reserved by DSH session ${claim.sessionId}`)
    }
    const stage = issueStage(issue)
    const resumable = claim?.sessionId === input.sessionId
    if (stage !== 'stage/ready' && !(resumable && (stage === 'stage/in-session' || stage === 'stage/agent-review'))) {
      throw new Error(`issue-session: issue #${number} is ${stage}, expected stage/ready`)
    }
    const dependencies = issueDependencies(issue.body, issue.number)
    await this.verifyDependencies(dependencies)
    const trusted = trustedComments(issue.comments, input.sessionId, issue.number)
    return {
      issue: approvedIssue(issue),
      stage,
      claim,
      dependencies,
      trustedAmendments: trusted.amendments,
      ignoredCommentCount: trusted.ignored,
    }
  }

  /**
   * Create or recover the local worktree, win one remote reservation, and reconcile the assignment comment and stage.
   * @param input - admitted issue and current session identity.
   * @returns the trusted briefing and isolated implementation worktree.
   */
  async claim(input: AdmissionInput): Promise<ClaimResult> {
    const admitted = await this.inspect(input)
    const worktree = await this.adapter.ensureWorktree(admitted.issue.number, input.sessionId, admitted.claim)
    const proposed: ClaimRecord = {
      issue: admitted.issue.number,
      sessionId: input.sessionId,
      branch: worktree.branch,
      worktree: worktree.path,
      base: worktree.base,
    }
    let claim = admitted.claim
    if (claim === undefined) {
      const created = await this.adapter.tryCreateClaim(proposed).catch(
        async (error: unknown) => removeRaceLoser(this.adapter, worktree, error),
      )
      if (created) {
        claim = proposed
      } else {
        let winner: ClaimRecord | undefined
        try {
          winner = await this.adapter.readClaim(admitted.issue.number)
        } catch (error) {
          await removeRaceLoser(this.adapter, worktree, error)
        }
        if (winner !== undefined && claimsMatch(winner, proposed)) {
          claim = winner
        } else {
          const owner = winner?.sessionId ?? 'an unreadable remote reservation'
          await removeRaceLoser(
            this.adapter,
            worktree,
            new Error(`issue-session: issue #${admitted.issue.number} is reserved by ${owner}`),
          )
        }
      }
    }
    if (claim === undefined) throw new Error(`issue-session: issue #${admitted.issue.number} claim reconciliation produced no owner`)
    if (claim.sessionId !== input.sessionId) {
      throw new Error(`issue-session: issue #${admitted.issue.number} is reserved by ${claim.sessionId}`)
    }
    if (!claimsMatch(claim, proposed)) {
      throw new Error(`issue-session: issue #${admitted.issue.number} reservation does not match this worktree`)
    }

    let issue = await this.adapter.readIssue(admitted.issue.number)
    const assignment = assignmentComment(input.sessionId)
    if (!issue.comments.some(comment => trustedOwner(comment) && comment.body === assignment)) {
      await this.adapter.addIssueComment(issue.number, assignment)
      issue = await this.adapter.readIssue(issue.number)
      if (!issue.comments.some(comment => trustedOwner(comment) && comment.body === assignment)) {
        throw new Error(`issue-session: assignment comment for issue #${issue.number} was not observed after creation`)
      }
    }
    const stage = issueStage(issue)
    if (stage === 'stage/ready') {
      await this.adapter.setIssueStage(issue.number, 'stage/ready', 'stage/in-session')
      issue = await this.adapter.readIssue(issue.number)
      if (issueStage(issue) !== 'stage/in-session') {
        throw new Error(`issue-session: issue #${issue.number} did not reach stage/in-session`)
      }
    } else if (stage !== 'stage/in-session' && stage !== 'stage/agent-review') {
      throw new Error(`issue-session: issue #${issue.number} reached unexpected ${stage} after reservation`)
    }
    return { ...admitted, issue: approvedIssue(issue), stage: issueStage(issue) as Stage, claim, worktree }
  }

  /**
   * Find or create the draft PR, then reconcile its issue link and agent-review stage.
   * @param input - claimed issue plus PR title, exact template body, and classification labels.
   * @returns the single draft PR and completed handoff state.
   */
  async handoff(input: HandoffInput): Promise<HandoffResult> {
    const admitted = await this.inspect(input)
    const labels = requireClassificationLabels(input.labels)
    requireHandoffBody(input.body, admitted.issue)
    const claim = admitted.claim
    if (claim === undefined || claim.sessionId !== input.sessionId) {
      throw new Error(`issue-session: issue #${admitted.issue.number} has no reservation for this session`)
    }
    let pullRequest = await this.adapter.findPullRequest(claim.branch)
    if (pullRequest === undefined) {
      try {
        pullRequest = await this.adapter.createPullRequest(claim.branch, input.title, input.body)
      } catch (error) {
        pullRequest = await this.adapter.findPullRequest(claim.branch)
        if (pullRequest === undefined) throw error
      }
    } else if (pullRequest.title !== input.title || pullRequest.body !== input.body) {
      try {
        await this.adapter.updatePullRequest(pullRequest.number, input.title, input.body)
      } catch (error) {
        const recovered = await this.adapter.findPullRequest(claim.branch)
        if (recovered === undefined || recovered.title !== input.title || recovered.body !== input.body) throw error
        pullRequest = recovered
      }
      pullRequest = await this.adapter.findPullRequest(claim.branch)
      if (pullRequest === undefined) throw new Error(`issue-session: updated PR for ${claim.branch} disappeared`)
    }
    requireDraftPullRequest(pullRequest, claim.branch)
    requireHandoffBody(pullRequest.body, admitted.issue)

    if (!pullRequestLabelsMatch(pullRequest, labels)) {
      try {
        await this.adapter.setPullRequestLabels(pullRequest.number, labels)
      } catch (error) {
        const recovered = await this.adapter.findPullRequest(claim.branch)
        if (recovered === undefined || !pullRequestLabelsMatch(recovered, labels)) throw error
        pullRequest = recovered
      }
      pullRequest = await this.adapter.findPullRequest(claim.branch)
      if (pullRequest === undefined) throw new Error(`issue-session: labeled PR for ${claim.branch} disappeared`)
    }
    requireDraftPullRequest(pullRequest, claim.branch)
    if (pullRequest.title !== input.title || pullRequest.body !== input.body) {
      throw new Error(`issue-session: PR ${pullRequest.url} did not reach the requested title and body`)
    }
    requireHandoffBody(pullRequest.body, admitted.issue)
    if (!pullRequestLabelsMatch(pullRequest, labels)) {
      throw new Error(`issue-session: PR ${pullRequest.url} did not reach the required classification labels`)
    }

    let issue = await this.adapter.readIssue(admitted.issue.number)
    const link = `Draft implementation PR: ${pullRequest.url}`
    if (!issue.comments.some(comment => trustedOwner(comment) && comment.body === link)) {
      await this.adapter.addIssueComment(issue.number, link)
      issue = await this.adapter.readIssue(issue.number)
      if (!issue.comments.some(comment => trustedOwner(comment) && comment.body === link)) {
        throw new Error(`issue-session: PR link for issue #${issue.number} was not observed after creation`)
      }
    }
    const stage = issueStage(issue)
    if (stage === 'stage/in-session') {
      await this.adapter.setIssueStage(issue.number, 'stage/in-session', 'stage/agent-review')
      issue = await this.adapter.readIssue(issue.number)
    }
    if (issueStage(issue) !== 'stage/agent-review') {
      throw new Error(`issue-session: issue #${issue.number} did not reach stage/agent-review`)
    }
    return { issue: issue.number, pullRequest, stage: 'stage/agent-review' }
  }

  private async verifyDependencies(urls: readonly string[]): Promise<void> {
    for (const url of urls) {
      const dependency = await this.adapter.readDependency(url)
      const satisfied = dependency.kind === 'pull-request' ? dependency.merged : dependency.closed
      if (!satisfied) {
        const required = dependency.kind === 'pull-request' ? 'MERGED' : 'CLOSED'
        throw new Error(`issue-session: unresolved dependency ${dependency.url}; expected ${required}`)
      }
    }
  }
}

/**
 * Canonicalize a worktree path for stable Node/Git comparisons on one host.
 * @param value - absolute or repository-relative path emitted by Node or Git.
 * @param platform - host path convention; tests supply win32 on other hosts.
 * @returns the absolute comparison spelling used by owner and worktree records.
 */
export function canonicalWorktreePath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return pathWin32.resolve(value).replaceAll('\\', '/').toLowerCase()
  return resolve(value)
}

function worktreePathsEqual(left: string, right: string): boolean {
  return canonicalWorktreePath(left) === canonicalWorktreePath(right)
}

/** Real Git and GitHub adapter used by the command-line entry point. */
export class GitHubIssueSessionAdapter implements IssueSessionAdapter {
  constructor(private readonly cwd: string, private readonly command: CommandRunner = run) {}

  async verifyRepository(): Promise<void> {
    const [{ stdout: owner }, { stdout: remote }, { stdout: login }] = await Promise.all([
      this.command(
        'gh',
        ['repo', 'view', REPOSITORY, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        this.cwd,
      ),
      this.command('git', ['remote', 'get-url', 'origin'], this.cwd),
      this.command('gh', ['api', 'user', '--jq', '.login'], this.cwd),
    ])
    if (owner.trim() !== REPOSITORY) throw new Error(`issue-session: current gh repository is ${owner.trim()}, expected ${REPOSITORY}`)
    if (!isAphRemote(remote.trim())) throw new Error(`issue-session: origin is ${remote.trim()}, expected ${REPOSITORY}`)
    if (login.trim() !== OWNER) throw new Error(`issue-session: authenticated GitHub login is ${login.trim()}, expected ${OWNER}`)
  }

  async readIssue(number: number): Promise<IssueRecord> {
    const { stdout } = await run('gh', [
      'issue', 'view', String(number), '--repo', REPOSITORY, '--comments', '--json',
      'number,title,body,state,labels,comments,url,author',
    ], this.cwd)
    return JSON.parse(stdout) as IssueRecord
  }

  async readClaim(number: number): Promise<ClaimRecord | undefined> {
    const remoteRef = claimRemoteRef(number)
    const trackingRef = claimTrackingRef(number)
    try {
      await run('git', ['fetch', 'origin', `${remoteRef}:${trackingRef}`], this.cwd)
    } catch (error) {
      if (await remoteRefExists(remoteRef, this.cwd)) throw error
      return undefined
    }
    const { stdout } = await run('git', ['show', '-s', '--format=%B', trackingRef], this.cwd)
    return parseClaimMessage(stdout, number)
  }

  async readDependency(url: string): Promise<DependencyRecord> {
    const pull = url.match(/^https:\/\/github\.com\/DavSimFel\/aph\/pull\/(\d+)$/u)
    if (pull !== null) {
      const pullNumber = pull[1]
      if (pullNumber === undefined) throw new Error(`issue-session: invalid pull request dependency URL ${url}`)
      const { stdout } = await this.command(
        'gh',
        ['pr', 'view', pullNumber, '--repo', REPOSITORY, '--json', 'state,mergedAt,url'],
        this.cwd,
      )
      const record = JSON.parse(stdout) as { state: string; mergedAt: string | null; url: string }
      if (record.url !== url) throw new Error(`issue-session: GitHub returned ${record.url} for dependency ${url}`)
      return { url: record.url, kind: 'pull-request', closed: record.state === 'CLOSED', merged: record.mergedAt !== null }
    }
    const issue = url.match(/^https:\/\/github\.com\/DavSimFel\/aph\/issues\/(\d+)$/u)
    const issueNumber = issue?.[1]
    if (issueNumber === undefined) throw new Error(`issue-session: unsupported dependency URL ${url}`)
    const { stdout } = await this.command(
      'gh',
      ['issue', 'view', issueNumber, '--repo', REPOSITORY, '--json', 'state,url'],
      this.cwd,
    )
    const record = JSON.parse(stdout) as { state: string; url: string }
    if (record.url !== url) throw new Error(`issue-session: GitHub returned ${record.url} for dependency ${url}`)
    return { url: record.url, kind: 'issue', closed: record.state === 'CLOSED', merged: false }
  }

  async ensureWorktree(number: number, sessionId: string, claim: ClaimRecord | undefined): Promise<WorktreeRecord> {
    const { stdout: rootOutput } = await run('git', ['rev-parse', '--show-toplevel'], this.cwd)
    const root = rootOutput.trim()
    const physicalRoot = await realpath(root)
    const worktreeRoot = join(root, '.aph-worktrees')
    const path = canonicalWorktreePath(join(worktreeRoot, `issue-${number}`))
    const branch = `issue-${number}-implementer`
    const ownerFile = join(worktreeRoot, `issue-${number}.owner.json`)
    const dependenciesFile = join(worktreeRoot, `issue-${number}.dependencies.json`)
    const storePath = join(worktreeRoot, '.pnpm-store')
    await ensureContainedDirectory(physicalRoot, worktreeRoot, 'worktree root')
    await ensureContainedDirectory(physicalRoot, storePath, 'pnpm store')
    await ensureContainedDirectoryIfPresent(physicalRoot, path, `issue #${number} worktree`)
    await ensureLocalExclude(root)
    await run('git', ['fetch', 'origin', 'dev:refs/remotes/origin/dev'], root)
    const { stdout: baseOutput } = await run('git', ['rev-parse', 'origin/dev'], root)
    const currentBase = baseOutput.trim()
    if (claim !== undefined) requireMatchingClaim(claim, { issue: number, sessionId, branch, worktree: path })

    let owner = await readOwner(ownerFile, number)
    if (owner !== undefined && owner.sessionId !== sessionId) {
      throw new Error(`issue-session: local issue #${number} worktree belongs to DSH session ${owner.sessionId}`)
    }
    let existing = await findIssueWorktree(root, path, branch)
    if (existing !== undefined && (!worktreePathsEqual(existing.path, path) || existing.branch !== `refs/heads/${branch}`)) {
      throw new Error(`issue-session: local branch or worktree for issue #${number} is owned by another session`)
    }
    if (owner === undefined && existing !== undefined && claim === undefined) {
      throw new Error(`issue-session: local branch or worktree for issue #${number} has no durable owner`)
    }

    const intended: ClaimRecord = claim ?? { issue: number, sessionId, branch, worktree: path, base: currentBase }
    if (owner === undefined) {
      await publishOwner(ownerFile, intended)
      owner = intended
    } else if (claim === undefined) {
      requireMatchingClaim(owner, { issue: number, sessionId, branch, worktree: path })
    } else {
      requireMatchingClaim(owner, intended)
    }

    if (claim === undefined && owner.base !== currentBase) {
      await removeProvisionalWorktree(root, existing, owner, dependenciesFile)
      await rm(ownerFile, { force: true })
      owner = { ...intended, base: currentBase }
      await publishOwner(ownerFile, owner)
      existing = undefined
    }

    let created = false
    if (existing === undefined) {
      await addOwnedWorktree(root, owner, claim !== undefined)
      existing = await findIssueWorktree(root, path, branch)
      if (existing === undefined) throw new Error(`issue-session: created worktree ${path} was not registered`)
      await ensureContainedDirectoryIfPresent(physicalRoot, path, `issue #${number} worktree`)
      created = true
    }
    if (!worktreePathsEqual(existing.path, path) || existing.branch !== `refs/heads/${branch}`) {
      throw new Error(`issue-session: local branch or worktree for issue #${number} is owned by another session`)
    }
    await ensureWorktreeDependencies(path, dependenciesFile, storePath)
    if (claim === undefined) await verifyFreshWorktree(path, owner.base)
    else await verifyClaimedWorktree(path, owner.base)
    return { path, branch, base: owner.base, created }
  }

  async removeWorktree(worktree: WorktreeRecord): Promise<void> {
    const root = dirname(dirname(worktree.path))
    const errors: unknown[] = []
    await captureCleanup(errors, () => run('git', ['worktree', 'remove', '--force', worktree.path], root))
    await captureCleanup(errors, () => run('git', ['branch', '-D', worktree.branch], root))
    const match = worktree.path.match(/issue-(\d+)$/u)
    if (match !== null) {
      await captureCleanup(errors, () => rm(join(dirname(worktree.path), `issue-${match[1]}.owner.json`), { force: true }))
      await captureCleanup(errors, () => rm(join(dirname(worktree.path), `issue-${match[1]}.dependencies.json`), { force: true }))
    }
    if (errors.length > 0) throw new AggregateError(errors, `issue-session: failed to remove losing worktree ${worktree.path}`)
  }

  async tryCreateClaim(claim: ClaimRecord): Promise<boolean> {
    const message = `${CLAIM_MESSAGE_HEADER}\n${JSON.stringify(claim)}`
    const { stdout: tree } = await run('git', ['rev-parse', `${claim.base}^{tree}`], this.cwd)
    const { stdout: commit } = await run('git', [
      'commit-tree', tree.trim(), '-p', claim.base, '-m', message,
    ], this.cwd)
    try {
      await run('git', ['push', 'origin', `${commit.trim()}:${claimRemoteRef(claim.issue)}`], this.cwd)
      return true
    } catch (error) {
      if (await remoteRefExists(claimRemoteRef(claim.issue), this.cwd)) return false
      throw error
    }
  }

  async addIssueComment(number: number, body: string): Promise<void> {
    await run('gh', ['issue', 'comment', String(number), '--repo', REPOSITORY, '--body', body], this.cwd)
  }

  async setIssueStage(number: number, from: Stage, to: Stage): Promise<void> {
    await run('gh', ['issue', 'edit', String(number), '--repo', REPOSITORY, '--remove-label', from, '--add-label', to], this.cwd)
  }

  async findPullRequest(branch: string): Promise<PullRequestRecord | undefined> {
    const { stdout } = await run('gh', [
      'pr', 'list', '--repo', REPOSITORY, '--head', branch, '--state', 'all', '--limit', '10',
      '--json', 'number,url,title,body,state,isDraft,baseRefName,headRefName,labels',
    ], this.cwd)
    const records = JSON.parse(stdout) as PullRequestRecord[]
    const open = records.filter(record => record.state === 'OPEN')
    if (open.length > 1) throw new Error(`issue-session: branch ${branch} has multiple open pull requests`)
    return open[0]
  }

  async createPullRequest(branch: string, title: string, body: string): Promise<PullRequestRecord> {
    await run('gh', [
      'pr', 'create', '--repo', REPOSITORY, '--draft', '--base', 'dev', '--head', branch,
      '--title', title, '--body', body,
    ], this.cwd)
    const created = await this.findPullRequest(branch)
    if (created === undefined) throw new Error(`issue-session: created PR for ${branch} was not discoverable`)
    return created
  }

  async updatePullRequest(number: number, title: string, body: string): Promise<void> {
    await run('gh', [
      'api', '--method', 'PATCH', `repos/${REPOSITORY}/pulls/${number}`,
      '-f', `title=${title}`, '-f', `body=${body}`,
    ], this.cwd)
  }

  async setPullRequestLabels(number: number, labels: readonly string[]): Promise<void> {
    await run('gh', [
      'api', '--method', 'PUT', `repos/${REPOSITORY}/issues/${number}/labels`,
      ...labels.flatMap(label => ['-f', `labels[]=${label}`]),
    ], this.cwd)
  }
}

function trustedComments(
  comments: readonly IssueComment[],
  sessionId: string,
  issueNumber: number,
): { amendments: string[]; ignored: number } {
  const assignment = assignmentComment(sessionId)
  const assignments = comments.filter(comment => trustedOwner(comment) && comment.body === assignment)
  if (assignments.length > 1) {
    throw new Error(`issue-session: issue #${issueNumber} has multiple assignment records for this session`)
  }
  const assignedAt = assignments[0] === undefined ? undefined : commentTime(assignments[0], issueNumber)
  const amendments: string[] = []
  let ignored = 0
  for (const comment of comments) {
    if (!trustedOwner(comment)) {
      ignored += 1
      continue
    }
    if (STATE_COMMENT_PREFIXES.some(prefix => comment.body.startsWith(prefix))) continue
    if (assignedAt === undefined || commentTime(comment, issueNumber) <= assignedAt) {
      ignored += 1
      continue
    }
    amendments.push(comment.body)
  }
  return { amendments, ignored }
}

function trustedOwner(comment: IssueComment): boolean {
  return comment.author.login === OWNER && comment.authorAssociation === 'OWNER'
}

function commentTime(comment: IssueComment, issueNumber: number): number {
  const time = Date.parse(comment.createdAt)
  if (!Number.isFinite(time)) throw new Error(`issue-session: issue #${issueNumber} has a comment with invalid creation time`)
  return time
}

function issueDependencies(body: string, issueNumber: number): string[] {
  const lines = body.split(/\r?\n/u)
  const headings = lines.map((line, index) => line.trim() === '## Dependencies' ? index : -1).filter(index => index >= 0)
  if (headings.length > 1) throw new Error('issue-session: issue body has multiple ## Dependencies sections')
  const start = headings[0]
  if (start === undefined) throw new Error('issue-session: issue body is missing the required ## Dependencies section')
  const section = lines.slice(start + 1).findIndex(line => /^##\s+/u.test(line.trim()))
  const entries = lines.slice(start + 1, section < 0 ? undefined : start + 1 + section)
    .map(line => line.trim())
    .filter(line => line !== '' && !/^<!--.*-->$/u.test(line))
  if (entries.length === 0) throw new Error('issue-session: ## Dependencies must contain `- None` or repository issue and pull request URLs')
  if (entries.length === 1 && entries[0] === '- None') return []
  if (entries.includes('- None')) throw new Error('issue-session: ## Dependencies cannot combine `- None` with URLs')
  const dependencies = entries.map((entry) => {
    const match = entry.match(/^- (https:\/\/github\.com\/DavSimFel\/aph\/(?:issues|pull)\/[1-9]\d*)$/u)
    if (match?.[1] === undefined) throw new Error(`issue-session: invalid dependency entry ${entry}`)
    return match[1]
  })
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error('issue-session: ## Dependencies contains a duplicate URL')
  }
  if (dependencies.includes(`https://github.com/${REPOSITORY}/issues/${issueNumber}`)) {
    throw new Error(`issue-session: issue #${issueNumber} cannot depend on itself`)
  }
  return dependencies
}

function issueStage(issue: IssueRecord): string {
  const stages = issue.labels.map(label => label.name).filter(name => name.startsWith('stage/'))
  const stage = stages[0]
  if (stages.length !== 1 || stage === undefined) {
    throw new Error(`issue-session: issue #${issue.number} must carry exactly one stage/* label`)
  }
  return stage
}

function approvedIssue(issue: IssueRecord): ApprovedIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    url: issue.url,
    author: issue.author,
    labels: issue.labels,
  }
}

function parseIssueUrl(url: string): number {
  const match = url.match(/^https:\/\/github\.com\/DavSimFel\/aph\/issues\/([1-9]\d*)$/u)
  if (match === null) throw new Error(`issue-session: expected one ${REPOSITORY} issue URL, got ${url}`)
  return Number(match[1])
}

function requireSessionId(sessionId: string): void {
  if (sessionId.trim() === '') throw new Error('issue-session: DSH_SESSION_ID is required')
}

function assignmentComment(sessionId: string): string {
  return `Assigned to DSH session \`${sessionId}\` for implementation.`
}

function requireClassificationLabels(labels: readonly string[]): string[] {
  if (new Set(labels).size !== labels.length) throw new Error('issue-session: handoff labels must not contain duplicates')
  if (labels.some(label => !label.startsWith('kind/') && !label.startsWith('area/'))) {
    throw new Error('issue-session: handoff labels may contain only kind/* and area/* labels')
  }
  const kinds = labels.filter(label => label.startsWith('kind/'))
  const areas = labels.filter(label => label.startsWith('area/'))
  if (kinds.length !== 1) throw new Error('issue-session: handoff requires exactly one kind/* label')
  if (areas.length === 0) throw new Error('issue-session: handoff requires at least one area/* label')
  return [...labels].sort()
}

function pullRequestLabelsMatch(pullRequest: PullRequestRecord, labels: readonly string[]): boolean {
  const actual = pullRequest.labels.map(label => label.name).sort()
  return actual.length === labels.length && actual.every((label, index) => label === labels[index])
}

function requireHandoffBody(body: string, issue: ApprovedIssue): void {
  if (!body.startsWith('## For the operator\n')) {
    throw new Error('issue-session: PR body must begin with ## For the operator')
  }
  if (!body.includes(issue.url)) throw new Error(`issue-session: PR body must link issue #${issue.number}`)
  const demonstration = boldField(body, 'See it working')
  if (demonstration === undefined || !containsCommandOrUrl(demonstration)) {
    throw new Error('issue-session: PR body See it working must contain an exact command or URL')
  }
  const evidence = boldSection(body, 'Verification evidence')
  if (evidence === undefined || !containsCommandOrUrl(evidence)) {
    throw new Error('issue-session: PR body must contain command or URL verification evidence')
  }
  for (const requirement of verificationRequirements(issue.body)) {
    if (!containsObservedEvidence(evidence, requirement)) {
      throw new Error(`issue-session: PR verification evidence is missing command/URL and observed result for: ${requirement}`)
    }
  }
}

function boldField(body: string, name: string): string | undefined {
  const prefix = `**${name}:**`
  const line = body.split(/\r?\n/u).find(candidate => candidate.startsWith(prefix))
  return line?.slice(prefix.length).trim()
}

function boldSection(body: string, name: string): string | undefined {
  const lines = body.split(/\r?\n/u)
  const prefix = `**${name}:**`
  const start = lines.findIndex(line => line.startsWith(prefix))
  if (start < 0) return undefined
  const first = lines[start]?.slice(prefix.length).trim() ?? ''
  const rest: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\*\*[^*]+:\*\*/u.test(line) || line.trim() === '<details>') break
    rest.push(line)
  }
  return [first, ...rest].join('\n').trim()
}

function containsCommandOrUrl(value: string): boolean {
  if (/https:\/\/[^\s)]+/u.test(value)) return true
  return [...value.matchAll(/`([^`\n]+)`/gu)].some((match) => {
    const command = match[1]?.trim() ?? ''
    return command.startsWith('./') || /\s/u.test(command)
  })
}

function containsObservedEvidence(evidence: string, requirement: string): boolean {
  const prefix = `${requirement} — `
  const line = evidence.split(/\r?\n/u)
    .map(candidate => candidate.startsWith('- ') ? candidate.slice(2) : candidate)
    .find(candidate => candidate.startsWith(prefix))
  if (line === undefined) return false
  const separator = line.indexOf(' → ', prefix.length)
  if (separator < 0) return false
  const demonstrator = line.slice(prefix.length, separator).trim()
  const observed = line.slice(separator + 3).trim()
  return containsCommandOrUrl(demonstrator) && observed.length > 0
}

function verificationRequirements(body: string): string[] {
  const lines = body.split(/\r?\n/u)
  const start = lines.findIndex(line => line.trim() === '## Verification')
  if (start < 0) throw new Error('issue-session: issue body is missing the required ## Verification section')
  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line.trim())) break
    const trimmed = line.trim()
    if (trimmed === '' || /^<!--.*-->$/u.test(trimmed)) continue
    section.push(trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed)
  }
  if (section.length === 0) throw new Error('issue-session: issue ## Verification section is empty')
  return section
}

function requireDraftPullRequest(pullRequest: PullRequestRecord, branch: string): void {
  if (pullRequest.state !== 'OPEN' || !pullRequest.isDraft || pullRequest.baseRefName !== 'dev' || pullRequest.headRefName !== branch) {
    throw new Error(`issue-session: PR ${pullRequest.url} must be an open draft from ${branch} to dev`)
  }
}

function isAphRemote(remote: string): boolean {
  return [
    'https://github.com/DavSimFel/aph',
    'git@github.com:DavSimFel/aph',
    'ssh://git@github.com/DavSimFel/aph',
  ].includes(remote.endsWith('.git') ? remote.slice(0, -4) : remote)
}

function claimRemoteRef(number: number): string {
  return `refs/heads/aph-claims/issue-${number}`
}

function claimTrackingRef(number: number): string {
  return `refs/remotes/origin/aph-claims/issue-${number}`
}

function parseClaimMessage(message: string, number: number): ClaimRecord {
  const [header, json] = message.trim().split('\n', 2)
  if (header !== CLAIM_MESSAGE_HEADER || json === undefined) {
    throw new Error(`issue-session: remote reservation for issue #${number} has an invalid message`)
  }
  const claim = JSON.parse(json) as Partial<ClaimRecord>
  if (claim.issue !== number || typeof claim.sessionId !== 'string' || typeof claim.branch !== 'string'
    || typeof claim.worktree !== 'string' || typeof claim.base !== 'string') {
    throw new Error(`issue-session: remote reservation for issue #${number} has invalid fields`)
  }
  return claim as ClaimRecord
}

async function remoteRefExists(ref: string, cwd: string): Promise<boolean> {
  const { stdout } = await run('git', ['ls-remote', '--heads', 'origin', ref], cwd)
  return stdout.trim() !== ''
}

async function ensureContainedDirectory(physicalRoot: string, path: string, subject: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await ensureContainedDirectoryIfPresent(physicalRoot, path, subject)
}

async function ensureContainedDirectoryIfPresent(physicalRoot: string, path: string, subject: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`issue-session: ${subject} ${path} must be a real directory, not a link or other file`)
  }
  const physicalPath = await realpath(path)
  const location = relative(physicalRoot, physicalPath)
  if (location === '' || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new Error(`issue-session: ${subject} ${path} resolves outside the task checkout`)
  }
}

async function ensureLocalExclude(root: string): Promise<void> {
  const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], root)
  const common = stdout.trim()
  const exclude = join(isAbsolute(common) ? common : resolve(root, common), 'info', 'exclude')
  await mkdir(dirname(exclude), { recursive: true })
  const existing = await readFile(exclude, 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return ''
    throw error
  })
  if (existing.split(/\r?\n/u).includes('/.aph-worktrees/')) return
  const separator = existing.endsWith('\n') || existing === '' ? '' : '\n'
  await appendFile(exclude, `${separator}/.aph-worktrees/\n`)
}

async function findIssueWorktree(
  root: string,
  path: string,
  branch: string,
): Promise<{ path: string; branch: string | undefined } | undefined> {
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain', '-z'], root)
  return parseWorktrees(stdout).find(entry => worktreePathsEqual(entry.path, path) || entry.branch === `refs/heads/${branch}`)
}

async function localBranchHead(root: string, branch: string): Promise<string | undefined> {
  const { stdout } = await run('git', ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`], root)
  return stdout.trim() || undefined
}

async function publishCompleteFile(path: string, content: string): Promise<boolean> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  let closed = false
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    closed = true
    // A hard-link commit is no-clobber and exposes only the complete synced inode.
    await link(temp, path)
    return true
  } catch (error) {
    if (!isNodeError(error) || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error
    const existing = await lstat(path).catch((statError: unknown) => {
      if (isNodeError(statError) && statError.code === 'ENOENT') return undefined
      throw statError
    })
    if (existing === undefined) throw error
    return false
  } finally {
    if (!closed) await handle.close()
    await unlink(temp).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    })
  }
}

async function publishOwner(path: string, owner: ClaimRecord): Promise<void> {
  if (await publishCompleteFile(path, `${JSON.stringify(owner)}\n`)) return
  const existing = await readOwner(path, owner.issue)
  if (existing === undefined) throw new Error(`issue-session: local owner record ${path} disappeared during publication`)
  requireMatchingClaim(existing, owner)
}

async function readOwnedFile(path: string, subject: string): Promise<string | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return undefined
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`issue-session: ${subject} ${path} must be a real regular file`)
  }
  return readFile(path, 'utf8')
}

async function readOwner(path: string, number: number): Promise<ClaimRecord | undefined> {
  const content = await readOwnedFile(path, 'local owner record')
  if (content === undefined) return undefined
  const owner = JSON.parse(content) as Partial<ClaimRecord>
  if (owner.issue !== number || typeof owner.sessionId !== 'string' || typeof owner.branch !== 'string'
    || typeof owner.worktree !== 'string' || typeof owner.base !== 'string') {
    throw new Error(`issue-session: invalid local owner record ${path}`)
  }
  return owner as ClaimRecord
}

function claimsMatch(left: ClaimRecord, right: ClaimRecord): boolean {
  return left.issue === right.issue && left.sessionId === right.sessionId && left.branch === right.branch
    && worktreePathsEqual(left.worktree, right.worktree) && left.base === right.base
}

async function removeRaceLoser(
  adapter: IssueSessionAdapter,
  worktree: WorktreeRecord,
  primary: unknown,
): Promise<never> {
  try {
    await adapter.removeWorktree(worktree)
  } catch (cleanupError) {
    const message = primary instanceof Error ? primary.message : String(primary)
    throw new AggregateError([primary, cleanupError], message)
  }
  throw primary
}

async function captureCleanup(errors: unknown[], action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    errors.push(error)
  }
}

function requireMatchingClaim(actual: ClaimRecord, expected: {
  issue: number
  sessionId: string
  branch: string
  worktree: string
  base?: string
}): void {
  if (actual.issue !== expected.issue || actual.sessionId !== expected.sessionId || actual.branch !== expected.branch
    || !worktreePathsEqual(actual.worktree, expected.worktree)
    || (expected.base !== undefined && actual.base !== expected.base)) {
    throw new Error(`issue-session: issue #${expected.issue} ownership does not match this worktree`)
  }
}

async function addOwnedWorktree(root: string, owner: ClaimRecord, allowProgress: boolean): Promise<void> {
  const head = await localBranchHead(root, owner.branch)
  if (head === undefined) {
    await run('git', ['worktree', 'add', '-b', owner.branch, owner.worktree, owner.base], root)
    return
  }
  if (allowProgress) await verifyAncestor(root, owner.base, head)
  else if (head !== owner.base) throw new Error(`issue-session: unclaimed branch ${owner.branch} moved from its recorded base`)
  await run('git', ['worktree', 'add', owner.worktree, owner.branch], root)
}

async function removeProvisionalWorktree(
  root: string,
  existing: { path: string; branch: string | undefined } | undefined,
  owner: ClaimRecord,
  dependenciesFile: string,
): Promise<void> {
  if (existing !== undefined) {
    await verifyFreshWorktree(owner.worktree, owner.base)
    await run('git', ['worktree', 'remove', owner.worktree], root)
  }
  const head = await localBranchHead(root, owner.branch)
  if (head !== undefined) {
    if (head !== owner.base) throw new Error(`issue-session: unclaimed branch ${owner.branch} moved from its recorded base`)
    await run('git', ['branch', '-D', owner.branch], root)
  }
  await rm(dependenciesFile, { force: true })
}

async function ensureWorktreeDependencies(
  worktree: string,
  markerPath: string,
  storePath: string,
): Promise<void> {
  if (await readOwnedFile(markerPath, 'legacy dependency marker') !== undefined) {
    await rm(markerPath, { force: true })
  }
  const target = join(worktree, 'node_modules')
  const targetStat = await lstat(target).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (targetStat?.isSymbolicLink()) await unlink(target)
  else if (targetStat !== undefined && !targetStat.isDirectory()) {
    throw new Error(`issue-session: ${target} is not a dependency directory`)
  }
  await installWorktreeDependencies(worktree, storePath)
  const installed = await lstat(target).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (installed === undefined || installed.isSymbolicLink() || !installed.isDirectory()) {
    throw new Error(`issue-session: pnpm did not create real isolated dependencies for ${worktree}`)
  }
}

async function installWorktreeDependencies(worktree: string, storePath: string): Promise<void> {
  if (process.platform === 'win32') {
    const command = `pnpm install --frozen-lockfile --prefer-offline --store-dir "${storePath}"`
    await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], worktree)
    return
  }
  await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--store-dir', storePath], worktree)
}

async function verifyFreshWorktree(path: string, base: string): Promise<void> {
  const [{ stdout: status }, { stdout: head }] = await Promise.all([
    run('git', ['status', '--short'], path),
    run('git', ['rev-parse', 'HEAD'], path),
  ])
  if (status !== '') throw new Error(`issue-session: unclaimed worktree ${path} is dirty`)
  if (head.trim() !== base) throw new Error(`issue-session: unclaimed worktree ${path} moved from its recorded base`)
}

async function verifyClaimedWorktree(path: string, base: string): Promise<void> {
  const { stdout: head } = await run('git', ['rev-parse', 'HEAD'], path)
  await verifyAncestor(path, base, head.trim())
}

async function verifyAncestor(cwd: string, base: string, head: string): Promise<void> {
  try {
    await run('git', ['merge-base', '--is-ancestor', base, head], cwd)
  } catch {
    throw new Error(`issue-session: recorded base ${base} is not an ancestor of ${head}`)
  }
}

function parseWorktrees(output: string): Array<{ path: string; branch: string | undefined }> {
  const records: Array<{ path: string; branch: string | undefined }> = []
  let fields = new Map<string, string>()
  for (const field of output.split('\0')) {
    if (field === '') {
      if (fields.size > 0) records.push({ path: fields.get('worktree') ?? '', branch: fields.get('branch') })
      fields = new Map()
      continue
    }
    const separator = field.indexOf(' ')
    fields.set(separator < 0 ? field : field.slice(0, separator), separator < 0 ? '' : field.slice(separator + 1))
  }
  if (fields.size > 0) records.push({ path: fields.get('worktree') ?? '', branch: fields.get('branch') })
  return records
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function run(command: string, args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`issue-session: ${command} ${args.join(' ')} failed: ${error.message}`, { cause: error })
    }
    throw error
  }
}

interface CliOptions {
  readonly command: 'inspect' | 'claim' | 'handoff'
  readonly issueUrl: string
  readonly title?: string
  readonly bodyFile?: string
  readonly labels: readonly string[]
}

function parseCli(argv: readonly string[]): CliOptions {
  const [command, issueUrl, ...rest] = argv
  if (command !== 'inspect' && command !== 'claim' && command !== 'handoff') {
    throw new Error('usage: issue-session.ts <inspect|claim|handoff> <issue-url> [--title TITLE --body-file FILE --label LABEL ...]')
  }
  if (issueUrl === undefined) throw new Error('issue-session: issue URL is required')
  let title: string | undefined
  let bodyFile: string | undefined
  const labels: string[] = []
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (value === undefined) throw new Error(`issue-session: ${flag} requires a value`)
    if (flag === '--title') title = value
    else if (flag === '--body-file') bodyFile = value
    else if (flag === '--label') labels.push(value)
    else throw new Error(`issue-session: unknown option ${flag}`)
  }
  return {
    command,
    issueUrl,
    ...(title === undefined ? {} : { title }),
    ...(bodyFile === undefined ? {} : { bodyFile }),
    labels,
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  const sessionId = process.env.DSH_SESSION_ID ?? ''
  const coordinator = new IssueSessionCoordinator(new GitHubIssueSessionAdapter(process.cwd()))
  const common = { issueUrl: options.issueUrl, sessionId }
  let result: AdmissionResult | ClaimResult | HandoffResult
  if (options.command === 'inspect') result = await coordinator.inspect(common)
  else if (options.command === 'claim') result = await coordinator.claim(common)
  else {
    if (options.title === undefined || options.bodyFile === undefined) {
      throw new Error('issue-session: handoff requires --title and --body-file')
    }
    const body = await readFile(options.bodyFile, 'utf8')
    result = await coordinator.handoff({ ...common, title: options.title, body, labels: options.labels })
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
