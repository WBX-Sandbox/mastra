# Publishing `@wbx-sandbox/mastra` to npm

Same setup as the `wbxsandbox` SDK: the package is published from **github.com/WBX-Sandbox/mastra** by
`.github/workflows/release.yml` with **npm trusted publishing** (OIDC, staged). No npm token is stored
anywhere; every version is approved with 2FA on npmjs.com.

## One-time setup

### 1. Repository on GitHub

Create the public repository `WBX-Sandbox/mastra` and push this directory as its root (`main`).
Settings → Environments → **New environment** `npm` (optionally with required reviewers).

### 2. First publication (version 0.1.0 – the package must exist before a trusted publisher can be added)

**Option A – in the browser, with a temporary token (no Node.js needed):**

1. npmjs.com → your avatar → **Access Tokens → Generate New Token → Granular Access Token**:
   name `mastra-bootstrap`, expiration **7 days**, **Packages and scopes: Read and write**,
   scope **All packages** (the package does not exist yet), Generate, copy the token.
2. GitHub → `WBX-Sandbox/mastra` → **Settings → Secrets and variables → Actions → New repository
   secret**: name **`NPM_BOOTSTRAP_TOKEN`**, value = the token.
3. Publish the GitHub release `v0.1.0` (see [Every release](#every-release)). The workflow stages
   the version with the token (`npm stage publish` can create a new package).
4. npmjs.com → **Staged Packages** → `@wbx-sandbox/mastra` → **Approve** (2FA).
5. Right after it is public: **delete the secret** in GitHub and **the token** on npmjs.com.

**Option B – from a computer with Node.js 22.13+:**

```sh
git clone https://github.com/WBX-Sandbox/mastra && cd mastra
npm ci && npm test
npm login            # npm account that owns the wbx-sandbox scope, confirm with 2FA
npm publish --access public
```

### 3. Trusted publisher (npmjs.com)

<https://www.npmjs.com/package/@wbx-sandbox/mastra> → **Settings → Trusted Publisher → GitHub Actions**:

- Organization or user: `WBX-Sandbox`
- Repository: `mastra`
- Workflow filename: `release.yml`
- Environment name: `npm`

Save (2FA). Same page, **Publishing access**: "Require two-factor authentication and disallow tokens".

## Every release

1. `main` has the new version in `package.json` and `src/version.ts`, the changelog entry, green CI.
2. GitHub → **Releases → Draft a new release** → tag `vX.Y.Z` (create on publish, target `main`) →
   title `vX.Y.Z`, changelog section as the description → **Publish release**.
3. The workflow tests and stages the version; approve it at npmjs.com → **Staged Packages** (2FA).

## Live tests in CI (optional)

Add the repository secret `WBXSANDBOX_API_KEY` (a key of a test account). The `live` job then runs
real sandboxes on every push to `main` and once a week; every sandbox it creates is deleted.
