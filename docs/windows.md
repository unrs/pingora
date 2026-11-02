# Windows

Windows is not currently supported by this binding.

Pingora has experimental Windows support upstream, but the binding has no
Windows CI lane, no Windows prebuilt target, and no end-to-end proxy test on
Windows. Shipping an unverified `.node` binary would be worse than deferring it.

The npm package therefore does not publish a Windows prebuilt binary, and
building from source on Windows is not a supported configuration.

Use WSL2 or a Linux/macOS host for development. Revisit this decision when
Pingora's Windows support is stable enough to exercise the proxy end to end and
a Windows runner can enforce it in CI.
