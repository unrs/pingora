# Changesets

Every user-facing change needs a changeset:

```sh
pnpm changeset
```

The release workflow turns pending changesets into a "Version Packages" pull
request. Merging that pull request publishes the new version.
