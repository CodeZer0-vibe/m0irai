#[cfg(feature = "grok-pager-room")]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    std::process::exit(zer0_v2_bin::cli::run_from_env().await);
}

#[cfg(not(feature = "grok-pager-room"))]
fn main() {
    eprintln!("m0irai was built without grok-pager-room support");
    std::process::exit(4);
}
