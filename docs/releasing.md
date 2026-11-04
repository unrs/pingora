# Releasing

Releases are driven by [Changesets](https://changesets.dev) and published by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) using npm
**trusted publishing** (GitHub Actions OIDC). No `NPM_TOKEN` secret is stored in
the repository.

## Packages

The release workflow publishes eight packages. `pingora` and its platform bindings
share the native version; `@pingora/http-server` is versioned independently.

| Package                            | Contents                              |
| ---------------------------------- | ------------------------------------- |
| `pingora`                          | CommonJS loader and type declarations |
| `@pingora/binding-linux-x64-gnu`   | Linux x64 (glibc) native addon        |
| `@pingora/binding-linux-arm64-gnu` | Linux arm64 (glibc) native addon      |
| `@pingora/binding-linux-x64-musl`  | Linux x64 (musl) native addon         |
| `@pingora/binding-linux-arm64-musl`| Linux arm64 (musl) native addon       |
| `@pingora/binding-darwin-x64`      | macOS Intel native addon              |
| `@pingora/binding-darwin-arm64`    | macOS Apple Silicon native addon      |
| `@pingora/http-server`             | Direct HTTP server facade (TypeScript) |

The repository does **not** list the platform packages in
`optionalDependencies`. At publish time `napi pre-publish` publishes the generated
platform packages and adds them to the root manifest; `changeset publish` then
publishes the root package and any other unpublished workspace packages. Local development uses the `.node` file produced by
`napi build`.

## Adding a changeset

Every user-facing pull request needs a changeset:

```sh
pnpm changeset
```

Commit the generated `.changeset/*.md` file with the change. Use `minor` for
features and `patch` for fixes while the project is pre-1.0. See the
[Changesets documentation](https://changesets.dev) for the format.

## Release flow

```text
pull request with a changeset
  -> merge to main
  -> release.yml creates/updates the "Version Packages" pull request
  -> merge that pull request
  -> release.yml sees no pending changesets
  -> asks https://registry.npmjs.org/pingora/<version>
       already present: skip native build
       missing: build native artifacts
  -> changesets/action/publish publishes every workspace version missing on npm
  -> tags and GitHub releases are created by Changesets
```

The workflow checks the root native version on npm only to decide whether native
artifacts must be rebuilt. The JS package versions are decided by Changesets
itself. That makes the check safe to retry after a failed run:

- if the root native version is already on npm, native rebuilding is skipped;
- Changesets still publishes any other workspace version missing from npm;
- if a previous run failed before publishing, the next push to `main` tries
  again.

There is no manual `workflow_dispatch` path and no manual version bump. To retry
a failed release, re-run the failed workflow from the Actions tab or push another
commit to `main`.

## What the version pull request contains

`pnpm run version` runs:

```sh
changeset version
cargo set-version --workspace "$(node -p 'require("./package.json").version')"
```

- `changeset version` updates `package.json`, writes `CHANGELOG.md`, and removes
  the consumed changesets.
- `cargo set-version` comes from
  [`cargo-edit`](https://github.com/killercup/cargo-edit) and updates both
  `Cargo.toml` and `Cargo.lock`.
- Run `just init` locally to install `cargo-edit` along with the other
  development dependencies.

The version pull request should contain the root `package.json`, `Cargo.toml`,
`Cargo.lock`, `CHANGELOG.md`, and the deleted changeset files. When
`@pingora/http-server` changes, it also contains
`packages/http-server/package.json` and `packages/http-server/CHANGELOG.md`.

## Publishing

After the version pull request is merged, `release.yml`:

1. builds the six native targets only when the root native version is missing
   on npm;
2. uploads the generated `index.js` and `index.d.ts` from the Linux x64 build
   when native is being rebuilt;
3. runs `napi create-npm-dirs` and `napi artifacts` when native is being
   rebuilt;
4. runs `pnpm build:packages` for the workspace JS packages;
5. runs `napi pre-publish` for the platform packages when native is being
   rebuilt (existing versions are skipped);
6. runs `changesets/action/publish`, which executes `changeset publish`,
   publishes every unpublished workspace version, pushes tags, and creates the
   GitHub releases.

With pnpm workspaces, Changesets uses package-scoped tags:
`pingora@X.Y.Z` for the root package and `@pingora/http-server@X.Y.Z` for the
facade. Older releases used the historical `vX.Y.Z` tag; new releases should be
verified with the package-scoped tag.

Provenance attestations are attached to all packages.

## One-time setup

### 1. Reserve the package names

The npm organisation (or user) that owns the `@pingora` scope must be able to
publish to it. The package names are already reserved. The musl x64/arm64 placeholders have
been published at `0.0.0` and their trusted publishers are configured. If a new
platform target is added, publish a placeholder and configure it before the
first release that uses it.

### 2. Configure trusted publishing

For **each** of the eight packages, open the package settings on npmjs.com and
add a trusted publisher under **Settings → Trusted publishing**:

| Field             | Value          |
| ----------------- | -------------- |
| Publisher         | GitHub Actions |
| Organization/user | `unrs`         |
| Repository        | `pingora`      |
| Workflow filename | `release.yml`  |

Leave the environment field empty. The workflow filename must match exactly;
renaming it requires updating every trusted publisher configuration.

### 3. Allow GitHub Actions to create pull requests

In the repository settings, under **Actions → General**, enable **Allow GitHub
Actions to create and approve pull requests**. The version job needs this to
open the "Version Packages" pull request.

### 4. Confirm workflow permissions

The `release` job needs `contents: write` and `pull-requests: write`; the
`publish` job needs `contents: write` (to push the tag) and `id-token: write`
(for trusted publishing).

`actions/setup-node` is intentionally **not** given `registry-url`: that option
writes an `.npmrc` entry that expects `NODE_AUTH_TOKEN` and can take precedence
over OIDC. The workflow installs pnpm via `pnpm/action-setup` (the version comes
from `packageManager` in `package.json`) and publishes with `changeset publish`
through `changesets/action/publish`.

## Verifying a release

```sh
# Run for a native release.
npm view pingora@<pingora-version> version
npm install pingora@<pingora-version>
node -e "const { version } = require('pingora'); console.log(version())"
git ls-remote --tags origin "pingora@<pingora-version>"

# Run when the facade was released.
npm view @pingora/http-server@<http-server-version> version
npm install @pingora/http-server@<http-server-version>
node -e "console.log(typeof require('@pingora/http-server').createServer)"
git ls-remote --tags origin "@pingora/http-server@<http-server-version>"
```

Check that `CHANGELOG.md` names the release and that the GitHub Actions run has
`id-token` provenance.

## Troubleshooting

| Symptom                                             | Likely cause                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Version PR is not created                           | Actions cannot create pull requests; enable the repository setting above.        |
| `EOTP` / token prompt during publish                | OIDC was not used; check `id-token: write` and the trusted publisher config.      |
| `403 Forbidden` for one platform package            | That package has no trusted publisher configured, or the workflow name differs.  |
| `Access token expired or revoked`                   | The workflow/repository in the trusted publisher config is wrong. |
| `cannot publish over previously published versions` | The version already exists; the release job should have skipped it.              |
| Provenance missing                                  | `id-token: write` is absent or pnpm is too old for trusted publishing.           |
| `ERR_PNPM_GIT_UNCLEAN` / git check failure          | The publish command is missing `--no-git-checks` in CI.                          |
| Native build fails on macOS                         | Check `MACOSX_DEPLOYMENT_TARGET` and the Rust target installation in the matrix. |

## Versioning policy

The project is pre-1.0. Breaking changes may land in minor releases until
`1.0.0`; patch releases are reserved for fixes. See the roadmap for the API
stability plan.
