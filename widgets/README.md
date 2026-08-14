# Live widgets (display surface)

Ready-made, self-contained widget **types** for the agent-mobile display surface
(docs/display-surface.md). Each file is the `code` string of a
`register_widget_type` op the agent ships once; the agent then `add_widget`s a
tile and `publish`es data updates in place.

Contract each widget honors:
- `window.render(props)` — initial draw.
- `window.onData(data)` — in-place update (no re-registration, no peer repaint).
- Fully self-contained (`dom` only) — the sandbox is egress-free and has no
  access to the parent window / ApexCharts / the bridge.

| file | what it shows | sample `publish` data |
|------|---------------|----------------------|
| `weather-tile.js` | current + min/max + 6-hr outlook | `{title, now, min, max, cond, hourly:[{h,t}]}` |
| `clock-widget.js` | large time readout | `{ text:"14:32" }` |

Verified by `test-surface-integration.mjs` (16/16): a full register → test →
add → publish batch runs through `surface-core` → `render`/`data` effects +
`render_result` feedback, with the storage-cap and missing-asset guards.
