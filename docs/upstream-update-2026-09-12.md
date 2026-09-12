# Homey development app update audit — September 12, 2026

The live Homey inventory contained ten development installations. Source updates were compared against the current default branch of each public upstream using live Git remote readback.

| Development app | Installed before audit | Upstream result |
| --- | --- | --- |
| SwitchBot | 2.0.87 | Updates through 2.0.92, commit 86ae8e2; merged into the custom development app. |
| Govee | 2.17.24 custom | Includes current upstream 2.17.19, c9734d6. |
| Petlibro | 1.0.16 custom | Includes current upstream 1.0.6, a876891. |
| Third Reality | 1.0.31 custom | Current upstream HEAD eed10db already present. |
| Xiaomi Mi Flora | 4.5.0 custom | Current upstream HEAD 995bd0e already present. |
| Apple TV & HomePod | 1.8.2 custom | Includes current upstream HEAD 04f51a6 (1.8.0). |
| Energy Coach | 0.7.4 | Custom project; GitHub HEAD 70294bb matches local source. |
| AIRVERSA Verified Bridge | 1.0.0 | Custom app; no separate public upstream configured in its checkout. |
| CloudEdge Treat Feeder | 0.6.0 | Custom app; no separate public upstream configured in its checkout. |
| Tuya Pet Cloud | 0.6.0 | Custom app; no separate public upstream configured in its checkout. |

Tuya's local checkout is not an installed development app: the live Tuya installation is the store version 1.5.8. Anova's local app is not installed. Backups are excluded from development app inventory. HomeKit Controller is a store app and was excluded from this development update.

## SwitchBot merge

Upstream 2.0.88–2.0.92 provides power conversion fixes (already contributed by this fork), transient DNS handling, older-Homey BLE compatibility, richer log filters/statistics, cached BLE device discovery, polling management, and Lock Pro Matter Enabled (HUB) support including night-latch actions.

The merge preserves custom K11 schedules and monitoring, the approved 05:00 Quiet exception, the other schedules' continuous-away gate, command acceptance checks, cumulative energy meters, blind controls, curtain controls, independent light color, and OAuth command fixes. K11 scheduling/monitor source matches the existing published quiet-morning repair; the older original build directory was not used as the source of truth.

Two overlaps required deliberate integration:

- BLE polling remains serial, uses successfully parsed state to decide freshness, temporarily releases advertisement monitors for necessary polls, and releases busy flags even if monitor restoration fails.
- OAuth transient DNS retries apply to read requests; command/scene requests are not replayed by the new transport retry wrapper.

Existing driver IDs, capabilities, Flow card IDs, and argument names/types are retained. Existing lock-card device filters are extended for the new driver. No devices are recreated and no Flow definitions are rewritten.

## Validation

- 96 tests passed, including 11 new merge regressions.
- Syntax checks passed for 151 app, API, driver and library JavaScript files.
- Homey build and debug-level validation passed.
- Diff whitespace check passed with CRLF handling, matching upstream file line endings.
- Before installation: 72 SwitchBot devices; 117 total Flows; no broken Flows.
- No physical device command was issued as a test.

Tracking: [ALI-153](https://linear.app/alienops/issue/ALI-153).
