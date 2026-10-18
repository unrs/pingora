// The Changesets action runs a publish script when there are no pending
// changesets. Native packages are built and published by the release jobs that
// follow, so this step only confirms that the versioning PR is complete.
console.log('Versioning complete; native build and publish are handled by the release jobs.')
