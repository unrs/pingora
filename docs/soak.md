# Soak test

`pnpm soak` runs sustained traffic with route and handler churn and optional
repeated start/stop cycles. It reports requests, churn counts, failure count, and
process RSS.

## Two-hour run

Environment: Linux x64, Node 24, debug binding, 8 concurrent clients, one cycle.

| metric | value |
| --- | ---: |
| duration | 2 h |
| requests | 6,182,498 |
| route adds | 240,079 |
| handler toggles | 240,079 |
| failures | 0 |
| RSS start | 87.3 MiB |
| RSS end | 218.6 MiB |
| RSS max | 269.2 MiB |
| RSS growth | 131.3 MiB |

## Startup warm-up

A separate five-minute diagnostic sampled RSS every 30 seconds:

```text
29s  233.4 MiB
59s  271.5 MiB
89s  276.4 MiB
119s 276.6 MiB
149s 276.5 MiB
179s 276.8 MiB
209s 280.2 MiB
239s 280.3 MiB
269s 280.6 MiB
299s 280.8 MiB
```

Memory rose during native/V8 warm-up and then plateaued at roughly 276–281 MiB;
the last four minutes grew by about 9 MiB. The two-hour run ended lower than its
peak, which is consistent with allocator/GC behavior rather than monotonic
growth.

This is one run, not a universal memory guarantee. Re-run the harness on the
target platform when changing the binding, Pingora, or handler churn patterns.
