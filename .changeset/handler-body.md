---
'pingora': minor
---

Add `readHandlerBody` for direct handlers that need the buffered request body;
it requires `maxRequestBodyBytes`, honors `Expect: 100-continue`, and is bounded
by `handlerTimeoutMs`.
