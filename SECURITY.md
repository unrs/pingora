# Security policy

## Supported versions

Security fixes are provided for the latest published `0.2.x` release. Pre-1.0
minor releases may contain breaking changes; upgrade to the latest release before
reporting a binding issue.

## Reporting a vulnerability

Do **not** open a public issue.

Use GitHub private vulnerability reporting:

https://github.com/unrs/pingora/security/advisories/new

Include:

- the package and platform versions (`pingora`, Node.js, OS/architecture)
- the affected option or handler path
- a minimal reproduction, if possible
- the impact you believe is possible

You will get an acknowledgement through the advisory. Please allow time for a
fix and coordinated disclosure before publishing details.

## Scope

In scope:

- the Node binding, generated loader, and platform packages
- proxy request handling, header/body limits, TLS and route configuration
- the request handler and access-log bridge
- the documented metrics/health endpoints

Out of scope:

- vulnerabilities in Cloudflare Pingora itself; report those to
  [cloudflare/pingora](https://github.com/cloudflare/pingora/security)
- issues in a user's upstream application
- deployments that intentionally disable TLS verification or expose the metrics
  endpoint publicly
- denial of service that only requires exhausting resources the operator chose
  not to limit

The security checklist and current posture are in
[docs/security.md](./docs/security.md).
