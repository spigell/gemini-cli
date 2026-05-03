---
name: gemini-cli-fork-resyncer
description: >-
  Updates this fork to a newly released upstream gemini-cli version while
  preserving fork-specific patches, versioning, and validation gates.
---

# Procedure: Resync Fork to New Upstream Release

## Objective

Upgrade this fork to a target upstream release tag (for example `v0.40.0`) and
carry forward fork-specific behavior safely and repeatably.

Important: bump the fork from upstream, but do not apply fork patches back onto
the upstream release branch itself. Keep fork-specific changes isolated to the
fork resync branch and re-apply them only in the fork context.

## Inputs

- `target_tag`: Upstream release tag to sync to (required), for example
  `v0.39.0`.
- `fork_version_suffix`: Fork version strategy (required), for example
  `spigell.YYYYMMDD.<shortsha>`.
- `fork_patch_source`: Where fork-only patches come from (required):
  `existing-fork-commits` or `patch-branch`.
- `validation_level` (optional): `targeted` or `full`.

## Required Safety Rules

- Use `git-mcp` for all git operations.
- Always run git with full path: `git -C /project/my-shared-infra/my-gemini-cli ...`
- Do not rewrite remotes.
- Do not use destructive git commands unless explicitly requested.
- Preserve unrelated existing work; do not revert user changes.

## Step 1: Baseline and Branch Setup

1. Verify working tree and branch state.
2. Fetch upstream tag.
3. Create a branch named:
   `spigell/chore/update-to-<target_tag_without_v>`
4. Confirm the tag exists locally and points to the expected upstream commit.

## Step 2: Isolate Fork-Only Delta

1. Compute fork-only diff against the previous synced upstream baseline.
2. Split fork delta into:
   - Functional patches (code behavior).
   - Release/version metadata updates.
   - Temporary or accidental files (must not be carried).
3. Build a replay list with commit SHAs or file-scoped patch groups.
4. Treat the upstream tag as the base release to bump from, not a place to
   merge fork patches into.

## Step 3: Replay Patches onto Target Release

1. Start from the target upstream tag.
2. Replay only functional fork patches first.
3. Resolve conflicts with this policy:
   - Prefer upstream for broad refactors and generated files.
   - Re-apply fork intent at behavior level, not raw hunk copying.
   - Keep conflict resolution minimal and auditable.
4. Ensure no temporary artifacts are introduced (for example `.COMMIT_MSG.txt`).

## Step 4: Normalize Fork Versioning

1. Set versions in root and workspace `package.json` files to:
   `X.Y.Z-<fork_version_suffix>`.
2. Update `sandboxImageUri` tags to the same fork version in root and CLI
   package config where present.
3. Regenerate lockfile with `npm install --ignore-scripts` if prepare/bundle
   scripts are unstable during merge state.
4. Stage all resolved manifest and lockfile changes.

## Step 5: Validate

Minimum validation:

- `npm run build`
- Targeted tests for fork-modified logic (for example fallback and MCP retry
  paths).

If `validation_level=full`:

- `npm run test`
- Optional `npm run preflight` at the end only when needed.

When failures occur:

1. Fix only regressions introduced by replay/conflict resolution.
2. Re-run the smallest failing scope first.
3. Re-run full requested validation after targeted fixes pass.

## Step 6: Finalize Merge/Commits

1. Confirm no unresolved conflicts remain.
2. Create clean commit(s):
   - Commit A: functional replay/conflict resolutions.
   - Commit B: fork version/lockfile metadata.
3. Commit message format:
   - Line 1: concise summary.
   - Line 2: blank.
   - Line 3: why this update was needed and what it preserves.

## Step 7: Push and PR

1. Push branch to origin.
2. Open/update PR with:
   - Target upstream tag.
   - Fork patches carried forward.
   - Validation commands run and results.
   - Known residual risks, if any.
3. If requested, request developer review.

## Step 8: Trigger Image Build (Optional)

If the fork update requires a new container image, trigger the
`google-gemini-publish.yaml` workflow in the `spigell/my-images` repository on
the `main` branch.

1. Use the GitHub Actions trigger tool, such as
   `mcp_github-mcp_actions_run_trigger` or `gh workflow run`.
2. Pass exactly two inputs to the workflow:
   - `gemini_cli_git_ref`: the name of the newly pushed branch, for example
     `spigell/chore/update-to-0.40.0`.
   - `gemini_cli_version`: the newly generated version string from
     `package.json`, for example `0.40.0-spigell.20260501.3d5bdc052`.
3. Critical warning: the `gemini_cli_version` input must always receive the
   exact version string. Never pass the branch name to the version input.

## Output Contract

Always report:

- Target tag synced.
- Fork patch set applied (list of commits or behavioral groups).
- Files materially changed by fork logic.
- Validation status with pass/fail and key errors.
- Final branch name and push status.
