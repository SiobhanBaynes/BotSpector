# Azure Pipelines

`ci-pr.yml` enforces formatting, linting, type safety, unit coverage, dependency
auditing, secret scanning, and a production build. It then packages and launches
the unsigned application on hosted macOS and Windows agents and publishes the
installers as pipeline artifacts.

`release.yml` runs only for `v*` tags. The tag must exactly match the version in
`package.json`, such as `v0.2.0` for version `0.2.0`. It repeats every quality
gate, signs and notarizes macOS x64 and arm64 packages, signs the Windows x64
package, verifies each signature, launches packages compatible with the hosted
agent architecture, and publishes the installers.

## Enable PR validation

Azure Repos Git uses a branch policy for pull-request validation rather than a
YAML `pr` trigger:

1. In **Pipelines**, create a pipeline from the existing
   `.azdo/ci-pr.yml` file.
2. In **Repos > Branches**, open the branch policies for `main`.
3. Add the pipeline under **Build validation** and make it automatic and
   required.

The YAML CI trigger also runs the pipeline after changes are merged into `main`.

## Main branch protections

`main` requires the BotSpector CI build, one approval from someone other than
the PR creator, and resolution of every PR comment. Approval votes reset when
the source branch changes. Contributors and the repository owner cannot force
push or bypass push/PR policies on `main`. Pipeline job tokens are project-scoped
and can access only explicitly referenced repositories.

## Configure release signing

Signing material must stay in Azure Pipelines and must never be committed to the
repository.

1. Export a **Developer ID Application** certificate and private key as a P12
   named `BotSpector-macOS.p12`.
2. Create an App Store Connect API key for notarization and save it as
   `AuthKey_BotSpector.p8`.
3. Export the Windows code-signing certificate and private key as a PFX named
   `BotSpector-Windows.pfx`.
4. Upload all three files under **Pipelines > Library > Secure files**. Authorize
   the `BotSpector Release` pipeline to use each file.
5. Create a variable group named `BotSpector-Release-Signing` with these secret
   variables: `MAC_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER`, and `WINDOWS_CERTIFICATE_PASSWORD`.
6. Authorize the `BotSpector Release` pipeline to use the variable group.
7. Create that pipeline from `.azdo/release.yml` without running it until all
   signing resources are configured.

Prepare the version change on a branch and merge it through a pull request:

```bash
git switch -c chore/release-v0.2.0
npm version 0.2.0 --no-git-tag-version
npm run check
git add package.json package-lock.json
git commit -m "chore: release v0.2.0"
git push -u origin chore/release-v0.2.0
az repos pr create --project BotSpector --repository BotSpector --target-branch main
```

After approval, CI, and merge, tag the exact tested `main` commit:

```bash
git switch main
git pull --ff-only
git tag v0.2.0
git push origin v0.2.0
```

The release fails closed when a secure file, password, API key field, signature,
notarization ticket, package smoke test, or version-matching tag is missing.
