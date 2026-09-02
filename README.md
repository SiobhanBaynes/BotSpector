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
