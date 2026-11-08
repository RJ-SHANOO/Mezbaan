# Watchdog sidecar binaries

Tauri's `bundle.externalBin` (tauri.conf.json) requires every referenced sidecar to
exist on disk *at compile time* — `cargo check`/`cargo build` validate this via
`tauri-build`'s build script, which runs for plain `cargo test` too, not just
`tauri build`. A missing file breaks every build on that platform, not just
packaging.

`mezbaan-watchdog-x86_64-pc-windows-msvc.exe` is the real compiled watchdog binary
(built locally and committed, since this repo's primary target is Windows — see
CLAUDE.md's "low-spec Windows 10 POS PC").

The other target-triple files here (`mezbaan-watchdog-x86_64-unknown-linux-gnu`,
`mezbaan-watchdog-aarch64-apple-darwin`, `mezbaan-watchdog-x86_64-apple-darwin`) are
placeholders — just enough to exist and satisfy the compile-time check for
`ci.yml`'s Linux `cargo test` step and `release.yml`'s macOS/Linux matrix jobs.
They are never executed as-is: `release.yml` compiles the real watchdog for each
platform in a dedicated step and overwrites the matching placeholder *before*
`tauri build` runs, so the real packaged installer always ships a real binary.

The watchdog's source lives in the standalone `apps/desktop/watchdog` crate, not
as a second `[[bin]]` under this app's own Cargo.toml. That was the first attempt,
and it compiles fine, but actually running `tauri build` (not just `cargo
check`/`cargo test`) surfaces a real MSI failure: Tauri's Windows bundler
auto-discovers and bundles every `[[bin]]` target of the app's own package, so a
same-package "mezbaan-watchdog" bin collides with the externalBin sidecar copy of
the exact same name — WiX's `light.exe` rejects it with ICE30 ("The target file
... is installed ... by two different components", "breaks component reference
counting"). Moving the watchdog to an unrelated package with its own target/
sidesteps this: cargo never produces that extra same-named binary next to
app.exe in the first place.

If you rebuild the Windows one locally after changing
`apps/desktop/watchdog/src/main.rs`:

```
cargo build --release --manifest-path apps/desktop/watchdog/Cargo.toml
cp apps/desktop/watchdog/target/release/mezbaan-watchdog.exe apps/desktop/src-tauri/binaries/mezbaan-watchdog-x86_64-pc-windows-msvc.exe
```
