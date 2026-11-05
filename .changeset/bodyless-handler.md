---
"pingora": patch
"@pingora/http-server": patch
---

Skip request-body reads for bodyless requests when `readHandlerBody` is enabled, using Pingora's downstream body state so HTTP/1.1 and HTTP/2 framing are handled correctly.
