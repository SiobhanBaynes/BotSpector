# BotSpector 🕵️

Your slightly nosy PR sidekick. A desktop app (Electron + React + TypeScript) that
snoops through pull requests from your Azure DevOps repositories and reviews each one
with a GitHub Copilot–powered agent. Findings are grouped into
**Blocking / High / Medium / Low / Nit**, each with its own ID and status, and can
be expanded, explained, drafted into a comment, and posted back to Azure DevOps.

## How it works

- **GitHub Copilot** is the review model backend. You sign in once via the GitHub
  OAuth **device flow** (no API key), and pick from the latest Claude / GPT models.
- **Azure DevOps** is accessed through the official Microsoft
  [`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp) MCP server,
  spawned by the app and authenticated with a **Personal Access Token (PAT)**.
- **SQLite** (better-sqlite3) stores PRs, reviews, findings, and comment drafts.
- Secrets (per-repository PATs + GitHub token) are encrypted at rest with Electron `safeStorage`.

## Prerequisites

- Node.js 20+ and npm
- A GitHub account with a Copilot subscription
- An Azure DevOps PAT with **Code: Read** and **Pull Request: Read** scopes

## Run

```bash
npm install      # installs deps and rebuilds better-sqlite3 for Electron
npm run dev      # launch in development
npm run build    # production bundle
npm run package  # build a distributable (electron-builder)
```

## Test

```bash
npm test              # run the unit suite once
npm run test:watch    # rerun affected tests while editing
npm run typecheck     # check main, renderer, and test TypeScript
```

## Build identity

Every app bundle embeds the version from `package.json`, its source commit, and its UTC build time.
GitHub Actions builds include the workflow run number, attempt, and ID. Azure Pipelines builds
retain their pipeline build number and ID. Local builds use a timestamped
`local-*` build number and show `*` beside the commit when the working tree was dirty. The compact
version is always visible in the sidebar, with complete details under **Settings → Diagnostics**.

## CI and releases

GitHub Actions runs formatting, linting, typechecks, unit coverage, dependency auditing,
secret scanning, and a production build on pull requests to `main` and pushes to `main`.
It also packages and smoke-tests unsigned macOS and Windows applications and uploads
test results, coverage, and installers as workflow artifacts.

`main` requires all three CI checks, one approval from someone other than the author,
and resolved review conversations. New commits dismiss stale approvals. Administrators
cannot bypass protection, and force pushes and branch deletion are blocked.

Releases run for `v*` tags. The tag must match `package.json` and point to a commit
already on `main`. All quality gates run again before macOS x64/arm64 and Windows x64
packages are built, smoke-tested, and uploaded as workflow artifacts.
After all platform builds pass, their installers and blockmaps are attached to a
GitHub Release for that tag. The release stays a draft until every asset upload
finishes. Only this publishing job has repository write permission.
Automatic publishing by electron-builder remains disabled.

Unsigned releases are enabled by setting the repository variable
`RELEASE_SIGNING_ENABLED` to `false` under **Settings → Secrets and variables →
Actions → Variables**. These builds need no signing certificates or secrets.
Download installers from the repository's **Releases** page. Unsigned releases are
labelled **unsigned** and include a security warning.
macOS Gatekeeper may block the app because it is not signed or notarized, and Windows
may show an unknown-publisher or SmartScreen warning. Only run builds you trust.

You can also select **Actions → Release → Run workflow** to build and test unsigned
installers without creating a version tag. Manual runs always produce unsigned
`BotSpector-unsigned-*` workflow artifacts; they do not publish a GitHub Release,
execute signing jobs, or require the release environment.

To enable signed tag releases later, add these secrets to the GitHub **release** environment under
**Settings → Environments → release**:

- `MAC_CERTIFICATE_BASE64`: base64-encoded Developer ID Application P12.
- `MAC_CERTIFICATE_PASSWORD`: password for that P12.
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect P8 key.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: the notarization key ID and issuer.
- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded Windows code-signing PFX.
- `WINDOWS_CERTIFICATE_PASSWORD`: password for that PFX.

Then set the repository variable `RELEASE_SIGNING_ENABLED` to `true`.
Signing secrets are never used by PR workflows or unsigned release jobs.
Missing credentials, invalid signatures, or failed notarization stop a signed release;
there is no automatic unsigned fallback when signing is enabled.
Tag releases fail if the variable is missing or is not exactly `true` or `false`.
The release environment accepts only `v*` tags. Certificates and keys from Azure secure
files must be reconfigured manually; do not commit them or paste them into PRs.

Merge a version change through a PR, then tag the tested `main` commit:

```bash
git switch main
git pull --ff-only origin main
git tag v0.1.0  # must match the version in package.json
git push origin v0.1.0
```

The files under `.azdo/` are retained for the existing Azure repository, not executed
by GitHub Actions. Azure PRs, branch policies, and secure files remain in Azure.

## First-time setup (in the app)

1. Open **Settings**.
2. Click **Sign in to GitHub Copilot** and enter the shown code at the URL.
3. Pick a **model** (latest Claude / GPT).
4. Add a named repository profile with its Azure DevOps **organization**, **project**,
   **repository**, **identity**, and **PAT**, then Save.
5. Go to **Pull requests**, Refresh, open a PR, and click **Review this PR**.

Add more repository profiles in **Settings**, then switch the active repository from the sidebar.
Each profile keeps its identity, PAT, pull requests, and review history separate. A project-scoped
PAT can be entered for each repository profile in that project.

## Notes

- The GitHub Copilot endpoints used here are the same ones editors use and are
  undocumented. Keep reviews user-initiated (per-PR) to stay within normal use.
- Posting a comment currently marks it posted locally. Real Azure DevOps posting
  is stubbed behind the `ADO_POSTING_ENABLED` flag in `src/main/ipc.ts` and can be
  wired to the MCP `repo_pull_request_thread_write` (create) tool later.
