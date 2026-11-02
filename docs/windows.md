# Windows

Windows is not currently supported by this binding.

Pingora has experimental Windows support upstream, but it is not enough for
this binding yet:

- Pingora's Windows `RunArgs` has no injectable shutdown signal; its server loop
  only reacts to Ctrl+C
- the binding's `stop()` relies on that shutdown signal, so a Windows build would
  hang on stop
- the binding also has no Windows CI lane, prebuilt target, or end-to-end test

A Windows build compiles once the cfg gaps are fixed, but shipping a `.node`
whose lifecycle cannot be stopped would be worse than deferring it.

The npm package therefore does not publish a Windows prebuilt binary, and
building from source on Windows is not a supported configuration.

Use WSL2 or a Linux/macOS host for development. Revisit this decision when
Pingora's Windows support is stable enough to exercise the proxy end to end and
a Windows runner can enforce it in CI.
