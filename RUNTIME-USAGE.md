# Runtime usage contract

`RunUsage` is a backwards-compatible runtime summary, not Pi's native
`Usage`. Legacy `tokens.input/output/total` and `cost.amount` may be present
without complete provider coverage.

A producer reports request coverage in `requests`:

- `total`: assistant receipts observed.
- `cacheKnown`: receipts with valid non-negative safe-integer
  `input`, `output`, `cacheRead`, and `cacheWrite`.
- `usageKnown`: receipts with every native token field
  (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`) valid and
  internally consistent, plus every cost component
  (`input`, `output`, `cacheRead`, `cacheWrite`, `total`) finite and
  non-negative.

`tokens.cacheRead`/`cacheWrite` and `cost.breakdown` are exact subtotals for
their known receipt sets; in a mixed run they are details-only and must not
be mapped to native usage. They are native-compatible run aggregates only when
`usageKnown === total`. Invalid values are not replaced with zero, and unsafe
aggregate overflow suppresses the affected exact aggregate rather than being
clamped.

## Mapping to Pi `Usage`

Map only a fully known runtime summary, with `requests.usageKnown ===
requests.total` and all fields below present:

```ts
const nativeUsage = {
  input: runtime.tokens.input,
  output: runtime.tokens.output,
  cacheRead: runtime.tokens.cacheRead,
  cacheWrite: runtime.tokens.cacheWrite,
  totalTokens: runtime.tokens.total,
  cost: {
    input: runtime.cost.breakdown.input,
    output: runtime.cost.breakdown.output,
    cacheRead: runtime.cost.breakdown.cacheRead,
    cacheWrite: runtime.cost.breakdown.cacheWrite,
    total: runtime.cost.amount,
  },
};
```

A partial native-shaped object is forbidden: Pi requires all five token
fields and all five cost fields. If coverage is mixed or legacy, retain the
runtime summary/details and do not fabricate missing cache or cost components.
