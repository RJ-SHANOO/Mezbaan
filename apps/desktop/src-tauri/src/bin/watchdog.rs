//! A small, independent helper process (P1-22): the main app spawns exactly one of
//! these at startup and never again (relaunches of the main app pass `--watched` so
//! it knows not to spawn a second one). This process just watches the main app's
//! PID and relaunches it if it disappears unexpectedly — a crash the main process
//! itself obviously can't recover from on its own, since it's the thing that died.
//!
//! Distinguishing "the user quit normally" from "it crashed": main writes a marker
//! file right before a deliberate exit (see lib.rs's RunEvent::Exit handling). If
//! the watched PID disappears and the marker is there, this was a clean shutdown —
//! clean up the marker and stop watching. If the marker is absent, it's a crash:
//! back off briefly, then relaunch main, with a cap on how many times this is
//! retried in a short window so a binary that's immediately and permanently broken
//! doesn't spawn processes in a tight loop forever.
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

const MAX_RESTARTS_PER_WINDOW: u32 = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const RESTART_BACKOFF: Duration = Duration::from_secs(2);

/// Caps how many restarts are allowed within a rolling window, so a binary that's
/// immediately and permanently broken doesn't spawn processes as fast as the OS
/// allows. Separated out from `main`'s loop purely so it's unit-testable without
/// needing real process spawning or PID polling.
struct RestartLimiter {
    window: Duration,
    max_restarts: u32,
    window_start: Instant,
    restarts_in_window: u32,
}

impl RestartLimiter {
    fn new(window: Duration, max_restarts: u32) -> Self {
        Self { window, max_restarts, window_start: Instant::now(), restarts_in_window: 0 }
    }

    /// Call right before attempting a restart. Returns true (and counts the
    /// attempt) if this one is allowed; false if the current window's cap is
    /// already reached.
    fn allow_restart(&mut self) -> bool {
        if self.window_start.elapsed() > self.window {
            self.window_start = Instant::now();
            self.restarts_in_window = 0;
        }
        if self.restarts_in_window >= self.max_restarts {
            return false;
        }
        self.restarts_in_window += 1;
        true
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let exe_path = args.get(1).expect("mezbaan-watchdog: missing <main-exe-path> arg").clone();
    let mut watched_pid: u32 = args
        .get(2)
        .expect("mezbaan-watchdog: missing <main-pid> arg")
        .parse()
        .expect("mezbaan-watchdog: <main-pid> must be a number");
    let marker_path = PathBuf::from(args.get(3).expect("mezbaan-watchdog: missing <clean-shutdown-marker-path> arg"));

    let mut system = System::new();
    let mut limiter = RestartLimiter::new(RESTART_WINDOW, MAX_RESTARTS_PER_WINDOW);

    loop {
        wait_until_gone(&mut system, watched_pid);

        if marker_path.exists() {
            let _ = fs::remove_file(&marker_path);
            break;
        }

        if !limiter.allow_restart() {
            eprintln!("mezbaan-watchdog: {MAX_RESTARTS_PER_WINDOW} restarts within {RESTART_WINDOW:?}, giving up");
            break;
        }

        sleep(RESTART_BACKOFF);
        match Command::new(&exe_path).arg("--watched").spawn() {
            Ok(child) => watched_pid = child.id(),
            Err(err) => {
                eprintln!("mezbaan-watchdog: failed to relaunch {exe_path}: {err}");
                break;
            }
        }
    }
}

fn wait_until_gone(system: &mut System, pid: u32) {
    loop {
        system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
        if system.process(Pid::from_u32(pid)).is_none() {
            return;
        }
        sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_the_max_restarts_within_a_window() {
        let mut limiter = RestartLimiter::new(Duration::from_secs(60), 3);
        assert!(limiter.allow_restart());
        assert!(limiter.allow_restart());
        assert!(limiter.allow_restart());
        assert!(!limiter.allow_restart());
    }

    #[test]
    fn resets_the_count_once_the_window_has_passed() {
        let mut limiter = RestartLimiter::new(Duration::from_millis(10), 1);
        assert!(limiter.allow_restart());
        assert!(!limiter.allow_restart());
        sleep(Duration::from_millis(25));
        assert!(limiter.allow_restart());
    }

    #[test]
    fn a_zero_max_restarts_never_allows_one() {
        let mut limiter = RestartLimiter::new(Duration::from_secs(60), 0);
        assert!(!limiter.allow_restart());
    }
}
