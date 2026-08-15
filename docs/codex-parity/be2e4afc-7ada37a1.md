# Codex parity review: `be2e4afc..7ada37a1`

This appendix classifies every commit in the exclusive local-checkout range

```text
openai/codex@be2e4afcd7392339d6adbaf0d31b26316bcaa2ab
    ..openai/codex@7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4
```

`git rev-list --count be2e4afcd7..7ada37a15e` returns `232`. The ordered list
below is mechanically comparable with
`git log --reverse --format=%h be2e4afcd7..7ada37a15e`.

The decision codes reuse the main ledger's policy:

- `P32` — optional MCP startup, readiness, and late completion do not block
  unrelated tools or lose a successful connection.
- `P33` — automatic MCP catalog pagination is bounded to 100 pages, 2,048
  items, 64-KiB cursors, and a 30-second collection window.
- `P34` — one ordered registry protects host tools and uses the first exact or
  normalized Code Mode identity consistently.
- `P35` — callers select direct/Code Mode exposure per registered tool and
  deferred/Code Mode exposure per MCP server.
- `P36` — function and custom definitions preserve eager wire shapes while
  supporting deferred loading, including custom namespace members.
- `P37` — complete caller/server namespace descriptions remain available;
  Nanocodex does not inherit Codex's temporary truncation.
- `P38` — known encrypted function-argument markers remain lossless in typed
  Responses history even though collaboration behavior stays out of scope.
- `P39` — the model-visible `tool_search` source advertisement is bounded to
  4 KiB without truncating UTF-8 or removing complete namespace descriptions
  from returned definitions.
- `P40` — MCP OAuth refreshes are serialized through durable persistence,
  preserve optional rotated-token fields, distinguish rejection from transient
  failure, survive caller cancellation, and retry one server-rejected access
  token through the exact RMCP 3 client behavior.
- `E15` — relevant runtime, transport, TUI, MCP, or cleanup behavior needs a
  focused Nanocodex regression, profile, or consumer before adoption.
- `D3` — the standalone sandbox-enabled V8 host, its packaging, and its
  WebSocket/recovery protocol are intentionally deferred. Nanocodex retains
  embedded QuickJS and explicit tool mediation.
- `O15` — the inspected change is app-server, persisted-thread, skills/plugin,
  approval, provider-account, generic environment/scheduler, shared HTTP,
  build/release, test-only, or superseded implementation work with no
  remaining Nanocodex invariant.

## Ordered classifications

```text
f2bee854a7 evaluate E15
8e271dc02b out-of-scope O15
d9e1c9cd55 port P32
e597169e9a out-of-scope O15
a68d0a74bd out-of-scope O15
f6160ca5b3 out-of-scope O15
7cde2323f3 out-of-scope O15
03748ad5e1 out-of-scope O15
84ccb2938b port P32
bb1af235ea out-of-scope O15
cf7e9cfe6a out-of-scope O15
fa1d4c40d0 out-of-scope O15
4f6eaf7af9 out-of-scope O15
8f00b9a04c out-of-scope O15
9ea975a2dc evaluate E15
709283b432 evaluate E15
dd6b880353 out-of-scope O15
8bbdf6c8f9 out-of-scope O15
155c3e299c out-of-scope O15
50a7328f50 out-of-scope O15
438c9e98db out-of-scope O15
12b3e88028 defer D3
1def0a8925 out-of-scope O15
c550cb3e01 out-of-scope O15
12b961d4c5 out-of-scope O15
3a797496f1 out-of-scope O15
9f4c20aadc evaluate E15
166658a34a out-of-scope O15
03edf16f0b port P38
101d6b8cb2 out-of-scope O15
8707a35113 out-of-scope O15
07490c7523 out-of-scope O15
fcd2273de7 out-of-scope O15
b9b7c21821 out-of-scope O15
28f3f1f9ef out-of-scope O15
9f23e97797 out-of-scope O15
0a6616f4cf out-of-scope O15
6c13b113a3 out-of-scope O15
250de82bfb out-of-scope O15
b96ebfb312 out-of-scope O15
d06c7ac055 evaluate E15
fe01054a28 out-of-scope O15
fbf666fa98 port P32
ddf33ea802 port P39
a4d2f31022 out-of-scope O15
9a6668f674 out-of-scope O15
e1895710ad out-of-scope O15
00cb5c465b out-of-scope O15
cef3910ea4 evaluate E15
3725f02cf3 evaluate E15
1ae2b9880e evaluate E15
1e3c0042eb evaluate E15
1da9f846b3 out-of-scope O15
f9b18d04ba out-of-scope O15
df326d31cd defer D3
a05bcda3db port P40
7579a2b413 out-of-scope O15
c41a38dd10 evaluate E15
ad6fc66b6d out-of-scope O15
09cf609218 out-of-scope O15
85c082cccc evaluate E15
a5082373f1 out-of-scope O15
88d6c2b2b4 out-of-scope O15
1dad11f818 out-of-scope O15
78a61de904 out-of-scope O15
5989dcc470 out-of-scope O15
9cf6b3905c out-of-scope O15
a1286d12a2 out-of-scope O15
3834c47ccb out-of-scope O15
3e3ae08839 port P33
6493417150 out-of-scope O15
7ec480dda5 evaluate E15
410c22b30e out-of-scope O15
7b93b3bf9c out-of-scope O15
b1ccaa0e08 out-of-scope O15
1c5f336c40 out-of-scope O15
406dc92394 evaluate E15
ff352fab62 out-of-scope O15
7d5253d2b0 out-of-scope O15
88ec932e96 out-of-scope O15
6219b7c40f evaluate E15
b293412c24 port P34
9a46fd33a0 port P32
3d805abdf0 out-of-scope O15
5decb399ae out-of-scope O15
89a0eed93c port P34
4f6d06d485 out-of-scope O15
c126f206da port P34
bdda5da56c out-of-scope O15
aa06446345 out-of-scope O15
9588f660be out-of-scope O15
5ad367fb95 out-of-scope O15
5a1097ed26 out-of-scope O15
25eecb071e out-of-scope O15
b545c94041 out-of-scope O15
2fbbb1a11a out-of-scope O15
856bf5a33a out-of-scope O15
13ddc7aa57 out-of-scope O15
b445967cc0 out-of-scope O15
578c1b2230 out-of-scope O15
355d2a802a out-of-scope O15
ceb4bc72c4 out-of-scope O15
0dcad0c972 out-of-scope O15
483559cc75 out-of-scope O15
9eeac78b3f out-of-scope O15
6256a7ccc7 out-of-scope O15
ba42e6866c out-of-scope O15
789c72dcf6 evaluate E15
0042b00986 evaluate E15
acd540f158 out-of-scope O15
97576b1794 defer D3
e6cfd40c3f out-of-scope O15
745603a5a1 out-of-scope O15
a01a2d9146 out-of-scope O15
3016671bb0 out-of-scope O15
413492cd6c out-of-scope O15
4642370542 out-of-scope O15
53d06e24ea defer D3
f0c30e528a out-of-scope O15
bf4d3f51ea out-of-scope O15
5e8b22488f out-of-scope O15
164b3bfeab out-of-scope O15
aea26afaee out-of-scope O15
66d63afd18 out-of-scope O15
ef293f7ac9 out-of-scope O15
448118f544 out-of-scope O15
5548c95d66 out-of-scope O15
3d1d26915a out-of-scope O15
7b38c48da9 out-of-scope O15
2c005abb07 out-of-scope O15
35eab50501 out-of-scope O15
c4f2746c43 evaluate E15
bbbf396839 out-of-scope O15
66ebeb7037 out-of-scope O15
d97cb0dcad out-of-scope O15
385fe95ce1 out-of-scope O15
da2c7ca8d1 out-of-scope O15
0d109f097c out-of-scope O15
287e1020ae out-of-scope O15
775fb21d2a port P34
845497f483 out-of-scope O15
b7a6106608 out-of-scope O15
2e32d95894 defer D3
d62353a312 out-of-scope O15
c42ea41ee0 out-of-scope O15
332eac4b85 out-of-scope O15
bf7804c254 out-of-scope O15
1bef168976 out-of-scope O15
dc60dadce6 out-of-scope O15
003ec63bba evaluate E15
64b2a3008e out-of-scope O15
670f69416b out-of-scope O15
a850875a8e out-of-scope O15
e2c0837923 out-of-scope O15
4c219fdb1a out-of-scope O15
6751b54cae out-of-scope O15
ee0247f95a out-of-scope O15
7dc1856685 evaluate E15
feee0b07c7 out-of-scope O15
a1dd74b535 out-of-scope O15
1e85ca099e out-of-scope O15
5825699981 port P33
2b5bdcf675 out-of-scope O15
9949245d1d out-of-scope O15
5157493c23 out-of-scope O15
bb5054fe47 out-of-scope O15
8b8fa7276f out-of-scope O15
1b594980f3 out-of-scope O15
dae2122214 out-of-scope O15
155f1ca9e5 out-of-scope O15
87e2d41eb3 out-of-scope O15
d6407d7359 out-of-scope O15
79479cdf09 out-of-scope O15
7dd2f689e9 out-of-scope O15
62839fec5d out-of-scope O15
7750465934 out-of-scope O15
c39d3e99d5 out-of-scope O15
8922a784fe out-of-scope O15
ca2b47997e port P34
c82cb044f3 out-of-scope O15
f94b5d899a out-of-scope O15
82ccbc757a evaluate E15
e4e040881a out-of-scope O15
224ea64cdc out-of-scope O15
78306a32af out-of-scope O15
136f75e7b7 out-of-scope O15
51c9ed6d4f port P35
bbcf5e10fb out-of-scope O15
df72fdb415 out-of-scope O15
e4e0c7070e out-of-scope O15
3149fa4b99 evaluate E15
bd12b3a9ec out-of-scope O15
51d4aa946c defer D3
1bbfb5cfad out-of-scope O15
cc03518c36 out-of-scope O15
9c8f9ce897 out-of-scope O15
41e2f67e56 out-of-scope O15
61dc1d97f6 evaluate E15
b258c028fe out-of-scope O15
60c722e075 defer D3
7431f10d0d out-of-scope O15
64bb8094ba out-of-scope O15
b2dc8b3e4b out-of-scope O15
8e3b5d3e87 defer D3
db1a414569 out-of-scope O15
5af85998c2 out-of-scope O15
12288240b4 port P36
d4fb78bfc5 port P36
9873cba8ce out-of-scope O15
2a16af8234 out-of-scope O15
4c25d6cc5c out-of-scope O15
77ce1d10aa out-of-scope O15
fd1e4d7a6d port P37
1669c2403f out-of-scope O15
6d4d9442c7 out-of-scope O15
fcf636a41d out-of-scope O15
17df7545a3 port P32
40e5de94e9 evaluate E15
18f03c1eb7 out-of-scope O15
f93109615f out-of-scope O15
49b0aebd6f out-of-scope O15
d98eb72e18 out-of-scope O15
d1f14e31a7 out-of-scope O15
bab7c2dcc1 out-of-scope O15
ee46c5ba0e out-of-scope O15
6a828ca26f out-of-scope O15
2999b8e831 out-of-scope O15
c8e255e7f8 out-of-scope O15
7325f348a2 out-of-scope O15
d75f94a94d out-of-scope O15
02bc1dd796 out-of-scope O15
7ada37a15e out-of-scope O15
```

## Port evidence

- `P32`: `runtime_construction_starts_providers_and_preserves_eager_prewarm`,
  `direct_model_calls_reach_activated_dynamic_tools`, MCP concurrent startup,
  and reload tests cover nonblocking provider startup and late reusable state.
- `P33`: `mcp::pagination` rejects repeated/oversized catalogs; resource
  integration tests exhaust valid multi-page results in order.
- `P34`: `registered_tools_cannot_replace_host_owned_routing_tools` and
  `first_registered_normalized_code_mode_name_wins_consistently` cover host
  reservation and first-winner prompt, metadata, and dispatch behavior.
- `P35`: `per_tool_exposure_selects_direct_and_code_mode_surfaces_independently`
  and `mcp_tool_exposure_selects_deferred_and_code_mode_surfaces_per_server`
  cover each supported surface while hidden handlers remain registered.
- `P36`: existing namespace serialization coverage plus
  `custom_tools_opt_into_deferred_loading_and_namespace_membership` cover eager
  compatibility, deferred custom tools, and custom namespace members.
- `P37`: MCP provider tests retain exact server descriptions in tool-search
  namespace output. The temporary Codex truncation in `ddf33ea802` is
  superseded by `fd1e4d7a6d` and is not adopted.
- `P38`: `function_calls_preserve_encrypted_argument_markers` round-trips both
  empty and populated `encrypted_function_args` fields through typed history.
- `P39`: `search_definition_bounds_aggregate_source_descriptions` keeps the
  source section within 4 KiB at a UTF-8 boundary while preserving configured
  source names. Namespace wire tests additionally reject nested namespace and
  `tool_search` children while retaining function/custom children.

## Classification totals

| Classification | Count |
| --- | ---: |
| `port` | 18 |
| `evaluate` | 24 |
| `defer` | 8 |
| `out-of-scope` | 182 |
| Total | 232 |
