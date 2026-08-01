#![cfg_attr(windows, windows_subsystem = "windows")]
// serde_json::json! expands one token-tree layer per default setting; the
// centralized settings schema intentionally exceeds Rust's default macro limit.
#![recursion_limit = "512"]

mod modules;

pub(crate) use modules::*;

fn main() {
    bootstrap::run();
}
