# TLS listeners

A listener with a `tls` object terminates TLS before requests reach the proxy:

```js
new Server({
  listeners: [
    '127.0.0.1:8080',
    {
      address: '127.0.0.1:8443',
      tls: { cert: '/etc/pingora/cert.pem', key: '/etc/pingora/key.pem' },
    },
  ],
})
```

## Certificate files

- `cert` is a PEM certificate chain, leaf certificate first.
- `key` is the matching PEM private key (PKCS#8 or RSA).
- Both files are read and validated by `start()`; a missing file, invalid PEM,
  or mismatched pair fails startup instead of failing a later handshake.
- Relative paths are resolved from the process working directory.

## Protocols

TLS 1.2 and 1.3 are enabled. ALPN prefers `h2` and falls back to
`http/1.1`, so HTTP/2 clients negotiate h2 while HTTP/1.1 clients keep working.
The request handler sees `scheme: 'https'` for TLS listeners.

## Rotation

Certificates are loaded when the server starts. Rotating a certificate requires
restarting the server; dynamic certificate reload is not implemented yet.

## Upstream TLS

`https://` upstreams verify the certificate and hostname by default. A private CA
bundle (one or more PEM certificates) can be supplied per upstream:

```js
upstreams: [
  {
    address: 'https://10.0.0.5:8443',
    sni: 'internal.example',
    ca: '/etc/pingora/internal-ca.pem',
  },
]
```

`verify: false` disables certificate and hostname verification. Use it only for
trusted networks or development.
