# Releasing

Releases are built and published by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) using npm
**trusted publishing** (GitHub Actions OIDC). No `NPM_TOKEN` secret is stored in
the repository.

## Packages

One release publishes five packages, all at the same version:

| Package                            | Contents                         |
| ---------------------------------- | -------------------------------- |
| `pingora`                          | CommonJS loader and type declarations |
| `@pingora/binding-linux-x64-gnu`   | Linux x64 (glibc) native addon   |
| `@pingora/binding-linux-arm64-gnu` | Linux arm64 (glibc) native addon |
| `@pingora/binding-darwin-x64`      | macOS Intel native addon         |
| `@pingora/binding-darwin-arm64`    | macOS Apple Silicon native addon |

The main package lists the platform packages as `optionalDependencies`; pnpm
installs only the one matching the host. The napi-rs loader resolves it at
runtime.

## One-time setup

### 1. Reserve the package names

The npm organisation (or user) that owns the `@pingora` scope must be able to
publish to it. Before configuring trusted publishing, publish a `0.0.0`
placeholder for each platform package so the names exist:

```sh
pnpm login
pnpm exec napi create-npm-dirs

for dir in npm/*; do
  pnpm --dir "$dir" publish --access public --no-git-checks
done
```

`npm/` is generated (and git-ignored); it is recreated by the release workflow.
The root `pingora` package is already reserved. Placeholder packages do not
contain a compiled addon; they only reserve the name. Do not install them as a
working binding.

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

The environment name must match the `environment: npm` on the `publish` job in
the workflow. The workflow filename must match exactly; renaming it requires
updating every trusted publisher configuration.

Once trusted publishing works, remove any long-lived `NPM_TOKEN` secret from the
repository.

### 3. Confirm the workflow permissions

The publish job needs:

```yaml
permissions:
  contents: read
  id-token: write # npm trusted publishing
```

`actions/setup-node` is intentionally **not** given `registry-url`: that option
writes an `.npmrc` entry that expects `NODE_AUTH_TOKEN` and can take precedence
over OIDC. The workflow installs pnpm via `pnpm/action-setup` (the version comes
from `packageManager` in `package.json`) and publishes with `pnpm publish`.

## Release procedure

Run these steps on `main`, after the release PR is merged, so the tag points at
reviewed code.

1. Bump the version. This updates `package.json`, the platform package versions,
   and `Cargo.toml`:

   ```sh
   just version 0.1.0
   ```

   `just` calls `pnpm version`, which triggers the `version` lifecycle script
   (`scripts/sync-versions.mjs`) to update the platform packages,
   `optionalDependencies`, and `Cargo.toml`.

2. Push the commit and tag:

   ```sh
   git push --follow-tags
   ```

3. The `v0.1.0` tag triggers `release.yml`:
   - four native builds run in parallel;
   - the x86_64 build uploads the generated `index.js` and `index.d.ts`;
   - `napi artifacts` copies each `.node` into its platform package;
   - `scripts/publish-platforms.mjs` publishes each `@pingora/binding-*`
     package, skipping versions that already exist;
   - `pnpm publish` publishes the `pingora` root package;
   - provenance attestations are attached to all packages.

4. Verify the release on npmjs.com and in the workflow run.

A maintainer can also run the workflow manually from the Actions tab
(`workflow_dispatch`). Manual runs use the version currently in
`package.json`; make sure it has not been published before.

## Troubleshooting

| Symptom                                             | Likely cause                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `EOTP` / token prompt during publish                | OIDC was not used; check `id-token: write` and the trusted publisher config.      |
| `403 Forbidden` for one platform package            | That package has no trusted publisher configured, or the workflow name differs.  |
| `Access token expired or revoked`                   | The npm environment/workflow/repository in the trusted publisher config is wrong. |
| `cannot publish over previously published versions` | The version already exists; bump it instead of re-running the same release.      |
| Provenance missing                                  | `id-token: write` is absent or pnpm is too old for trusted publishing.           |
| `ERR_PNPM_GIT_UNCLEAN` / git check failure          | The publish command is missing `--no-git-checks` in CI.                          |
| Native build fails on macOS                         | Check `MACOSX_DEPLOYMENT_TARGET` and the Rust target installation in the matrix. |

## Versioning

The project is pre-1.0. Breaking changes may land in minor releases until
`1.0.0`; patch releases are reserved for fixes. See the roadmap for the API
stability plan.
