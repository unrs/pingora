# Releasing

Releases are driven by [Changesets](https://changesets.dev) and published by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) using npm
**trusted publishing** (GitHub Actions OIDC). No `NPM_TOKEN` secret is stored in
the repository.

## Packages

One release publishes five packages, all at the same version:

| Package                            | Contents                              |
| ---------------------------------- | ------------------------------------- |
| `pingora`                          | CommonJS loader and type declarations |
| `@pingora/binding-linux-x64-gnu`   | Linux x64 (glibc) native addon        |
| `@pingora/binding-linux-arm64-gnu` | Linux arm64 (glibc) native addon      |
| `@pingora/binding-darwin-x64`      | macOS Intel native addon              |
| `@pingora/binding-darwin-arm64`    | macOS Apple Silicon native addon      |

The repository does **not** list the platform packages in
`optionalDependencies`. At publish time `napi pre-publish` publishes the generated
platform packages and adds them to the root manifest; `changeset publish` then
publishes `pingora`. Local development uses the `.node` file produced by
`napi build`.

## Adding a changeset

Every user-facing pull request needs a changeset:

```sh
just changeset
# or: pnpm changeset
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
  -> reads package.json version
  -> asks https://registry.npmjs.org/pingora/<version>
       already present: stop
       missing: build, publish, tag
```

The workflow checks the npm registry directly rather than comparing git tags or
commits. That makes the check safe to retry after a failed run:

- if the version is already on npm, nothing is published again;
- if a previous run failed before publishing, the next push to `main` tries
  again.

There is no manual `workflow_dispatch` path and no manual version bump. To retry
a failed release, re-run the failed workflow from the Actions tab or push another
commit to `main`.

## What the version pull request contains

`pnpm run version` runs:

```sh
changeset version
node scripts/sync-versions.mjs
cargo metadata --format-version 1 > /dev/null
```

- `changeset version` updates `package.json`, writes `CHANGELOG.md`, and removes
  the consumed changesets.
- `sync-versions.mjs` copies the npm version into `Cargo.toml`.
- `cargo metadata` updates the `pingora-node` entry in `Cargo.lock` without a
  full compile.

The version pull request should contain `package.json`, `Cargo.toml`,
`Cargo.lock`, `CHANGELOG.md`, and the deleted changeset files.

## Publishing

After the version pull request is merged, `release.yml`:

1. builds four native targets;
2. uploads the generated `index.js` and `index.d.ts` from the Linux x64 build;
3. runs `napi create-npm-dirs` and `napi artifacts`;
4. runs `napi pre-publish`, which publishes each `@pingora/binding-*` package
   and adds the platform packages to the root manifest (existing versions are
   skipped);
5. runs `changesets/action/publish`, which executes `changeset publish`,
   publishes `pingora`, creates the `vX.Y.Z` tag (this repository is a single
   root package, which is the tag format Changesets uses), pushes the tag, and
   creates the GitHub release.

Provenance attestations are attached to all packages.

## One-time setup

### 1. Reserve the package names

The npm organisation (or user) that owns the `@pingora` scope must be able to
publish to it. The package names are already reserved. If a new platform target
is added, publish a placeholder for it before the first release that uses it.

### 2. Configure trusted publishing

For **each** of the five packages, open the package settings on npmjs.com and
add a trusted publisher under **Settings → Trusted publishing**:

| Field             | Value          |
| ----------------- | -------------- |
| Publisher         | GitHub Actions |
| Organization/user | `unrs`         |
| Repository        | `pingora`      |
| Workflow filename | `release.yml`  |
| Environment       | `npm`          |

The environment name must match `environment: npm` on the `publish` job. The
workflow filename must match exactly; renaming it requires updating every
trusted publisher configuration.

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
from `packageManager` in `package.json`) and publishes with `pnpm publish`.

## Verifying a release

```sh
npm view pingora@<version> version
npm view @pingora/binding-linux-x64-gnu@<version> version
npm install pingora@<version>
node -e "const { version } = require('pingora'); console.log(version())"
git ls-remote --tags origin "v<version>"
```

Check that `CHANGELOG.md` names the release and that the GitHub Actions run has
`id-token` provenance.

## Troubleshooting

| Symptom                                             | Likely cause                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Version PR is not created                           | Actions cannot create pull requests; enable the repository setting above.        |
| `EOTP` / token prompt during publish                | OIDC was not used; check `id-token: write` and the trusted publisher config.      |
| `403 Forbidden` for one platform package            | That package has no trusted publisher configured, or the workflow name differs.  |
| `Access token expired or revoked`                   | The npm environment/workflow/repository in the trusted publisher config is wrong. |
| `cannot publish over previously published versions` | The version already exists; the release job should have skipped it.              |
| Provenance missing                                  | `id-token: write` is absent or pnpm is too old for trusted publishing.           |
| `ERR_PNPM_GIT_UNCLEAN` / git check failure          | The publish command is missing `--no-git-checks` in CI.                          |
| Native build fails on macOS                         | Check `MACOSX_DEPLOYMENT_TARGET` and the Rust target installation in the matrix. |

## Versioning policy

The project is pre-1.0. Breaking changes may land in minor releases until
`1.0.0`; patch releases are reserved for fixes. See the roadmap for the API
stability plan.
