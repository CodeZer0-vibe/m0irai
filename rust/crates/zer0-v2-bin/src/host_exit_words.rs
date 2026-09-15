//! The words the launcher puts in front of an operator when a room host dies.
//!
//! Extracted from `host_shutdown` on 2026-09-13, along the seam round 2 named: these are presentation
//! and nothing else. They read `HostExit`, `HostExitCause`, `LauncherTermination` and
//! `TerminationBranch`; they do not touch a bound, a sample or a derivation, and nothing in the
//! shutdown policy calls into here. `host_shutdown` had reached 702 lines, which is past the line
//! clamp the Node half is held to and which no gate reaches inside `rust/` (FL-135) — growth is
//! answered by extraction.
//!
//! ONE rule governs every sentence below, and it is measured rather than stylistic: the room's failure
//! row CLIPS at the terminal width instead of wrapping, so a sentence that overruns loses its tail
//! silently and the tail is the clause that says WHY. 101 columns survive at 120
//! (`xai-grok-pager`'s `a_host_exit_reaches_the_failure_row_whole` measures it from the other side);
//! 96 is what `every_termination_sentence_fits_the_room_banner_row` holds this side to.

use std::fmt;

use crate::host_shutdown::{HostExit, HostExitCause, LauncherTermination, TerminationBranch};

impl fmt::Display for TerminationBranch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ShutdownReap { acknowledged: true } => {
                "it answered the shutdown and did not exit"
            }
            Self::ShutdownReap {
                acknowledged: false,
            } => "no acknowledgement came back from it",
            Self::TransportFailureReap => "its transport had failed and it did not exit",
            Self::OwnerDropped => "the room that owned it was dropped",
        })
    }
}

/// One line for the operator, and it has to FIT on one line.
///
/// MEASURED on 2026-09-12 rather than assumed: the room's failure row is a single compact block that
/// CLIPS at the terminal width instead of wrapping. At 120 columns — the width this repo's own
/// real-terminal proof uses — the accent rail and the `room failed — ` prefix leave 101 columns of
/// sentence, and everything past that is absent from the frame altogether, not even marked with an
/// ellipsis. The first draft was 147 characters and lost its last clause on the widest terminal we
/// test. So: no "itself", no "because", and no remark about the exit code, which this surface never
/// shows anyway. What an operator needs is who ended the process, why, and the bound it gave up on;
/// the longest branch renders 95 columns.
impl fmt::Display for LauncherTermination {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "m0irai ended the room host after waiting {} ms: {}",
            self.waited.as_millis(),
            self.branch
        )
    }
}

/// The operator's sentence for one exit, and the only description of a death in this crate: the
/// room's failure banner and the launcher's own warning both render THIS.
///
/// Every arm is selected by BOTH fields. Selecting on `cause` alone produced, for an exit carrying
/// `success: true` and a recorded terminate, "m0irai ended the room host itself after waiting 0 ms,
/// because the room that owned it was dropped (exit code Some(0) is the terminate's, not the host's)"
/// — false in both of its clauses at once, on a state that is reachable (A6, H-0 review 2026-09-12).
impl fmt::Display for HostExit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = ExitCode(self.code);
        match (self.cause, self.success) {
            // The terminate reached a process that had ALREADY finished its own clean exit. Reachable
            // rather than theoretical: `HostProcess::drop` records `OwnerDropped` whenever no exit has
            // yet been PUBLISHED, and on a loaded box the monitor's `child.wait()` runs hundreds of
            // milliseconds behind the host's real exit — the same scheduling delay this lane is about.
            // `TerminateJobObject` on an already-dead job does not change its exit code, so `code`
            // here is the host's own and means what it says.
            //
            // The branch is deliberately NOT named on this arm. Nothing was actually ended by the
            // launcher, so "because its transport had failed" would be reporting a decision that had
            // no effect on anything. `Debug` still carries it, for whoever reads a log.
            (HostExitCause::LauncherTerminated(termination), true) => write!(
                formatter,
                "the room host exited normally ({code}); m0irai's terminate landed {} ms into its \
                 wait",
                termination.waited.as_millis()
            ),
            // The termination's own sentence, unadorned. A clause about `code` used to hang off the
            // end here; it said "its code 1 is the terminate's" about a number this surface does not
            // print, and it was the part the 120-column clip deleted. `Debug` still carries the code
            // for a log.
            (HostExitCause::LauncherTerminated(termination), false) => termination.fmt(formatter),
            (HostExitCause::Host, true) => {
                write!(formatter, "the room host exited normally ({code})")
            }
            (HostExitCause::Host, false) => match self.code {
                Some(code) => write!(
                    formatter,
                    "the room host exited on its own with code {code}"
                ),
                None => formatter.write_str("the room host was ended by a signal"),
            },
        }
    }
}

/// An exit code as a sentence fragment.
///
/// `None` is not rendered as zero. A platform that reported no code has told us nothing, and printing
/// a made-up success is FL-143's mistake in miniature.
struct ExitCode(Option<i32>);

impl fmt::Display for ExitCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(code) => write!(formatter, "code {code}"),
            None => formatter.write_str("no exit code"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A6: every arm of the exit sentence, including the one that used to be false twice over.
    #[test]
    fn an_exit_sentence_is_chosen_by_the_cause_and_the_success_together() {
        let terminated = |success, code| HostExit {
            code,
            success,
            cause: HostExitCause::LauncherTerminated(LauncherTermination {
                branch: TerminationBranch::OwnerDropped,
                waited: Duration::ZERO,
            }),
        };
        // The state A6 found: a host that had already exited 0 when the terminate landed. Neither
        // "m0irai ended it" nor "the code is the terminate's" is true here.
        assert_eq!(
            terminated(true, Some(0)).to_string(),
            "the room host exited normally (code 0); m0irai's terminate landed 0 ms into its wait"
        );
        assert_eq!(
            terminated(false, Some(1)).to_string(),
            "m0irai ended the room host after waiting 0 ms: the room that owned it was dropped"
        );
        assert_eq!(
            HostExit {
                code: Some(0),
                success: true,
                cause: HostExitCause::Host,
            }
            .to_string(),
            "the room host exited normally (code 0)"
        );
        assert_eq!(
            HostExit {
                code: Some(7),
                success: false,
                cause: HostExitCause::Host,
            }
            .to_string(),
            "the room host exited on its own with code 7"
        );
        assert_eq!(
            HostExit {
                code: None,
                success: false,
                cause: HostExitCause::Host,
            }
            .to_string(),
            "the room host was ended by a signal"
        );
        // A platform that reported no code is never rendered as a zero.
        assert_eq!(
            terminated(true, None).to_string(),
            "the room host exited normally (no exit code); m0irai's terminate landed 0 ms into \
             its wait"
        );
    }

    #[test]
    fn a_launcher_termination_names_the_branch_and_the_wait_it_gave_up_on() {
        let termination = LauncherTermination {
            branch: TerminationBranch::ShutdownReap { acknowledged: true },
            waited: Duration::from_millis(6_204),
        };
        assert_eq!(
            termination.to_string(),
            "m0irai ended the room host after waiting 6204 ms: it answered the shutdown and did \
             not exit"
        );
        assert_eq!(
            LauncherTermination {
                branch: TerminationBranch::OwnerDropped,
                waited: Duration::ZERO,
            }
            .to_string(),
            "m0irai ended the room host after waiting 0 ms: the room that owned it was dropped"
        );
    }

    /// CX3: the same branch, the same reap, two different facts — and until round 3 the sentence
    /// asserted the first one on both paths.
    ///
    /// The reap runs whether or not the host answered, and nothing in the reap decision consults the
    /// response result, so "it answered the shutdown" was a claim the launcher had not checked. An
    /// operator told that will look for a host that hung AFTER answering; a host that never answered
    /// is a different problem in a different place.
    #[test]
    fn a_shutdown_reap_says_whether_an_acknowledgement_ever_came_back() {
        let reaped = |acknowledged| {
            LauncherTermination {
                branch: TerminationBranch::ShutdownReap { acknowledged },
                waited: Duration::from_millis(6_204),
            }
            .to_string()
        };
        assert_eq!(
            reaped(true),
            "m0irai ended the room host after waiting 6204 ms: it answered the shutdown and did \
             not exit"
        );
        assert_eq!(
            reaped(false),
            "m0irai ended the room host after waiting 6204 ms: no acknowledgement came back from it"
        );
        // Said of the LAUNCHER's knowledge on purpose. `acknowledged` is false both when the request
        // went out and nothing came back and when no request went out at all, and "no acknowledgement
        // came back" is true of both; "it never answered" would be a claim about the host that the
        // second case does not support.
        assert_ne!(reaped(true), reaped(false));
    }

    /// The room's failure row CLIPS at the terminal width (measured 2026-09-12: 101 columns of
    /// sentence survive at 120 columns, after the accent rail and the `room failed — ` prefix). So the
    /// length of this sentence is a contract, not a matter of taste — a sentence that overruns loses
    /// its last clause silently, and the last clause is the one that says why.
    ///
    /// 101 is the measured budget; 96 is asserted, leaving five columns of slack for a five-digit
    /// wait. Whoever makes one of these sentences longer gets this test, with the number in it.
    #[test]
    fn every_termination_sentence_fits_the_room_banner_row() {
        const BANNER_COLUMNS: usize = 96;
        for branch in [
            TerminationBranch::ShutdownReap { acknowledged: true },
            TerminationBranch::ShutdownReap {
                acknowledged: false,
            },
            TerminationBranch::TransportFailureReap,
            TerminationBranch::OwnerDropped,
        ] {
            for waited in [Duration::ZERO, Duration::from_millis(6_204)] {
                for success in [true, false] {
                    let exit = HostExit {
                        code: Some(1),
                        success,
                        cause: HostExitCause::LauncherTerminated(LauncherTermination {
                            branch,
                            waited,
                        }),
                    };
                    let sentence = exit.to_string();
                    assert!(
                        sentence.chars().count() <= BANNER_COLUMNS,
                        "the room's failure row clips at the terminal width, so this sentence loses \
                         its tail on a 120-column terminal: {} columns, {sentence:?}",
                        sentence.chars().count()
                    );
                }
            }
        }
    }
}
