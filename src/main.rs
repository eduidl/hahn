use clap::Parser;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(about = "Progressive MCAP plot viewer")]
struct Args {
    /// Directory containing immutable MCAP recordings (including subdirectories).
    #[arg(long, default_value = ".")]
    data_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1:3000")]
    listen: SocketAddr,
    #[arg(long, default_value = "web/dist")]
    web_dir: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let app = hahn::router(&args.data_dir)?.fallback_service(
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
