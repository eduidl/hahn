//! Hahn's command line, for Hahn itself and for servers built on it.

use crate::Builder;
use clap::Parser;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(about = "Progressive plot viewer for MCAP recordings")]
struct Args {
    /// Directory containing immutable MCAP recordings (including subdirectories), or a
    /// single recording file.
    #[arg(long, default_value = "data")]
    data_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1:3000")]
    listen: SocketAddr,
    #[arg(long, default_value = "client/dist")]
    web_dir: PathBuf,
    /// Compress API responses for clients that accept gzip. Worthwhile over a network,
    /// but slower than no compression on localhost.
    #[arg(long)]
    gzip: bool,
    /// IANA name of where the runs took place, such as Asia/Tokyo, for showing their times.
    #[arg(long)]
    timezone: Option<String>,
}

/// Parses Hahn's options, lets `configure` add to the server, and serves until Ctrl+C.
///
/// ```no_run
/// fn main() -> anyhow::Result<()> {
///     hahn::cli::main(|builder| builder /* .view(MyConverter) */)
/// }
/// ```
pub fn main(configure: impl FnOnce(Builder) -> Builder) -> anyhow::Result<()> {
    let args = Args::parse();
    let builder = configure(Builder::new(&args.data_dir).timezone(args.timezone));
    tokio::runtime::Runtime::new()?.block_on(serve(builder, args.listen, args.web_dir, args.gzip))
}

async fn serve(
    builder: Builder,
    listen: SocketAddr,
    web_dir: PathBuf,
    gzip: bool,
) -> anyhow::Result<()> {
    let (api, views) = builder.build()?;
    let api = if gzip { crate::gzip(api) } else { api };
    let app = api.fallback_service(
        tower_http::services::ServeDir::new(web_dir).append_index_html_on_directories(true),
    );
    println!("Views:");
    for view in views {
        println!("  {:<24} {:<20} {}", view.id, view.kind, view.name);
    }
    let listener = tokio::net::TcpListener::bind(listen).await?;
    println!("Hahn: http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
