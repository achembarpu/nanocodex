# JavaScript binding performance

The JavaScript boundary must remain small compared with a model turn. Its
deterministic gate runs against the built Node and browser WASM packages:

```sh
just build-wasm
node --test --test-timeout=15000 js/bindings/test/performance.bench.mjs
```

The gate measures costs owned by this package, not mocked model latency:

It runs after the functional test pool rather than inside it, so package
installation and lifecycle fixtures cannot contend with microbenchmarks.

| Boundary | Regression limit |
| --- | ---: |
| Cold Node or precompiled-browser `Agent.create` | 250 ms |
| Warm `Agent.create` p50 | 1.5 ms |
| Warm `Agent.create` p95 | 10 ms |
| JavaScript prompt action | 5 µs per call |
| Enqueue and drain 4,096 ordered events | 50 ms |
| Hosted Code Mode execution | 250 µs per call |
| Package-Worker completed-result envelope | 256 encoded bytes |
| Packed npm tarball | 1.1 MB |
| Unpacked npm package | 4.9 MB |

The warm measurements include enough unmeasured calls for V8 to tier up the
WASM constructor. The test separately proves that Node compiles and
instantiates its module once, and that browser agents reuse one caller-compiled
module and WASM instance.

The Worker result gate retains an 8 MiB snapshot behind a completed native
result, awaits `turn.result()`, and requires zero eager snapshot reads plus a
completion envelope below 256 bytes. Two concurrent `result.snapshot()` calls
must then share one Worker RPC, one Rust-owned JSON payload, and one immutable
parsed value. This models retained conversation growth without charging the
completion path for state the caller may never request.

The npm package intentionally contains separate Node and web glue plus a copy
of the same optimized Rust artifact beside each entry point. `wasm-bindgen`
emits incompatible loading conventions for those targets; duplicating the
artifact keeps both entry points relocation-safe. The compressed and unpacked
size gates make that deliberate cost visible.

On Apple Silicon with Node 23.6.0, the 2026-07-28 baseline was:

- Node cold create: 14.6 ms; warm p50/p95: 0.07/0.46 ms.
- Browser cold create: 40.8 ms; steady warm creates below 0.1 ms.
- Prompt action: 2.8 µs.
- 4,096 buffered events: 16.7 ms.
- Hosted Code Mode execution: 76.4 µs.
- 8 MiB retained Worker snapshot: 45-byte eager envelope, zero eager
  materializations, one on-demand RPC/materialization.
- npm package: 980,214 bytes compressed and 4,737,347 bytes unpacked.

Before the bounded indexed event queue, draining 100,000 buffered events took
4.64 seconds because each `Array.shift()` moved the remaining queue. Event
iterators now fail explicitly at their private count/size bound and release
their subscription, keeping the measured path linear and memory bounded.
