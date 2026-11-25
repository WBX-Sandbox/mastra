# Publishing `@wbx-sandbox/mastra` to npm

Same setup as the `wbxsandbox` SDK: the package is published from **github.com/WBX-Sandbox/mastra** by
`.github/workflows/release.yml` with **npm trusted publishing** (OIDC, staged). No npm token is stored
anywhere; every version is approved with 2FA on npmjs.com.

## One-time setup

### 1. Repository on GitHub

Create the public repository `WBX-Sandbox/mastra` and push this directory as its root (`main`).
Settings → Environments → **New environment** `npm` (optionally with required reviewers).

### 2. First publication (done – 0.1.0, 25 Nov 2026)

A trusted publisher can be added only to a package that already exists, so 0.1.0 was staged once
with a temporary granular token (GitHub secret `NPM_BOOTSTRAP_TOKEN`, 7 days). Both the secret and
the token were deleted right after the approval; the workflow no longer reads any token.

### 3. Trusted publisher (npmjs.com)

<https://www.npmjs.com/package/@wbx-sandbox/mastra> → **Settings → Trusted Publisher → GitHub Actions**:

- Organization or user: `WBX-Sandbox`
- Repository: `mastra`
- Workflow filename: `release.yml`
- Environment name: `npm`

Save (2FA). A new trusted publisher is *pending validation* until a release is published through it
(within 48 hours), otherwise it has to be added again. Same page, **Publishing access**: "Require two-factor authentication and disallow tokens".

## Every release

1. `main` has the new version in `package.json` and `src/version.ts`, the changelog entry, green CI.
2. GitHub → **Releases → Draft a new release** → tag `vX.Y.Z` (create on publish, target `main`) →
   title `vX.Y.Z`, changelog section as the description → **Publish release**.
3. The workflow tests and stages the version; approve it at npmjs.com → **Staged Packages** (2FA).

## Live tests in CI (optional)

Add the repository secret `WBXSANDBOX_API_KEY` (a key of a test account). The `live` job then runs
real sandboxes on every push to `main` and once a week; every sandbox it creates is deleted.
