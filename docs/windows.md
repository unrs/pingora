# Windows

Windows is not currently supported.

Pingora's supported production targets are Linux and macOS. A Windows binding
would need a separate transport/listener implementation and a Windows CI lane;
neither is planned for the 1.0 release. The npm package therefore does not
publish a Windows prebuilt binary, and building from source on Windows is not a
supported configuration.

Use WSL2 or a Linux/macOS host for development. Revisit this decision if Pingora
gains Windows support and a Windows runner can exercise the proxy end to end.
