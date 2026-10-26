---
'pingora': minor
---

Add a napi-postinstall runtime fallback for missing optional platform bindings.
This raises the minimum Node.js runtime to `^12.20.0 || ^14.18.0 || >=16.0.0`, matching napi-postinstall.
