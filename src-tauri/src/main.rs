// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // SSH askpass mode: wsl::git_command re-execs THIS SAME binary (see
    // askpass.rs's own module doc for why) as ssh's SSH_ASKPASS helper.
    // Checked before anything else touches Tauri at all — this entire
    // process instance's only job, when the marker is set, is to answer
    // ssh's one question and exit; it must never reach the normal app boot
    // below (which would try to open a whole second GitCat window instead).
    if gitcat_lib::askpass::is_askpass_invocation() {
        gitcat_lib::askpass::run_and_exit();
    }
    gitcat_lib::run()
}
