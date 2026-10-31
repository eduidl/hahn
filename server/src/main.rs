use clap::Parser;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(about = "Progressive plot viewer for MCAP, CSV and Parquet recordings")]
struct Args {
    /// Directory containing immutable recordings (MCAP, CSV, Parquet; including subdirectories).
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let api = hahn::router_with_timezone(&args.data_dir, args.timezone)?;
    let api = if args.gzip { hahn::gzip(api) } else { api };
    let app = api.fallback_service(
        tower_http::services::ServeDir::new(args.web_dir).append_index_html_on_directories(true),
    );
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    println!("Hahn: http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
