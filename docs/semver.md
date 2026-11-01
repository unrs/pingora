# Versioning and deprecation

The package follows semantic versioning from `1.0.0`.

## Public surface

The public API is:

- exports from the package root: `Server`, `version`, and the generated types
- `Server` constructor options, methods, status values, and events
- route, upstream, listener, TLS, and handler option shapes
- the request-handler request/response contract and access-log record shape
- the documented metrics and health endpoints

Rust internals, generated `.node` ABI details, benchmark/dev scripts, and
undocumented environment variables are not public API.

## Pre-1.0

Before `1.0.0`, a minor release may include breaking changes. Every breaking
change must have a Changesets entry describing the migration. Patch releases do
not intentionally break the public API.

## After 1.0.0

- **major**: breaking public API or behavior changes
- **minor**: backward-compatible features and deprecations
- **patch**: backward-compatible fixes and documentation

## Deprecation

1. Mark the API as deprecated in JSDoc/types and document the replacement.
2. Ship the deprecation in a minor release with a Changesets entry.
3. Keep it working for at least one minor release, and remove it only in the
   next major release.

Error message wording, log formatting, and benchmark numbers are not covered by
the compatibility guarantee.
