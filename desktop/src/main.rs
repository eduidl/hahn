//! Hahn as a desktop application: serves a recording the user picks on 127.0.0.1 and
//! shows the client in a window of its own.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::{Context, anyhow, bail};
use axum::{Router, body::Body, extract::Request};
use clap::Parser;
use std::{
    io,
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};
use tauri::{
    AppHandle, DragDropEvent, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tower_http::services::ServeDir;

/// The client saves the workspace per origin, so serving on the same port each time
/// restores it.
const DEFAULT_PORT: u16 = 3917;
const WINDOW: &str = "main";

#[derive(Parser)]
#[command(about = "Hahn as a desktop application")]
struct Args {
    /// MCAP recording to open. Without one, the window opens with no run, and a
    /// recording is opened from "Select run" or by dropping it onto the window.
    recording: Option<PathBuf>,
    /// Port on 127.0.0.1 to serve on. The workspace is restored only on the port it was
    /// saved on; when this port is in use, any free port is used instead.
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
    /// Built client to serve. Defaults to the one bundled with the application, or the
    /// repository's `client/dist` when running from the repository.
    #[arg(long)]
    web_dir: Option<PathBuf>,
    /// Shows the client from the development server at `build.devUrl` in
    /// tauri.conf.json, which `tauri dev` starts, instead of serving a built one.
    /// A relative recording is then found from where npm was run.
    #[arg(long)]
    dev: bool,
    /// IANA name of where the runs took place, such as Asia/Tokyo. Defaults to this
    /// computer's time zone; an empty value declares none.
    #[arg(long)]
    timezone: Option<String>,
}

fn main() {
    let args = Args::parse();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![select_recording])
        .setup(move |app| {
            let app = app.handle().clone();
            let client = match args.dev {
                true => Client::Dev,
                false => Client::Built(args.web_dir),
            };
            match Served::start(&app, args.port, client, args.timezone) {
                Ok(served) => {
                    app.manage(served);
                    // npm runs `tauri dev` in desktop/, but names its own directory.
                    let recording = match std::env::var_os("INIT_CWD") {
                        Some(dir) if args.dev => {
                            args.recording.map(|path| Path::new(&dir).join(path))
                        }
                        _ => args.recording,
                    };
                    let served = app.state::<Served>();
                    match show(&app, served.client.clone(), None) {
                        Ok(()) => {
                            if let Some(recording) = recording {
                                open(&app, recording);
                            }
                        }
                        Err(error) => fail(&app, error),
                    }
                }
                Err(error) => fail(&app, error),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Hahn could not start its window");
}

/// Lets the client's "Select run" pick a recording from the user's files.
#[tauri::command]
fn select_recording(app: AppHandle) {
    pick(&app);
}

/// Where the window gets the client from.
enum Client {
    /// From this server, which serves a built client from this directory or the
    /// default one.
    Built(Option<PathBuf>),
    /// From the development server, which forwards `/api` to this server.
    Dev,
}

/// What the server on 127.0.0.1 answers with: the recording opened last, or no run.
struct Served {
    /// Where the window loads the client, and so the origin it stays on.
    client: Url,
    /// None when the client comes from the development server.
    web_dir: Option<PathBuf>,
    timezone: Option<String>,
    router: Arc<RwLock<Router>>,
    recording: Mutex<Option<PathBuf>>,
    /// Served until a recording opens, so that the API lists no runs. Held to keep the
    /// directory until the app quits.
    _empty: tempfile::TempDir,
}

impl Served {
    fn start(
        app: &AppHandle,
        port: u16,
        client: Client,
        timezone: Option<String>,
    ) -> anyhow::Result<Self> {
        let (web_dir, listener) = match client {
            Client::Built(dir) => (Some(built_client(app, dir)?), bind(port)?),
            // The development server forwards to this port alone.
            Client::Dev => (
                None,
                TcpListener::bind((Ipv4Addr::LOCALHOST, port))
                    .with_context(|| format!("Cannot listen on port {port}"))?,
            ),
        };
        let timezone = match timezone {
            Some(zone) if zone.is_empty() => None,
            Some(zone) => Some(zone),
            None => iana_time_zone::get_timezone().ok(),
        };
        let origin: Url = format!("http://{}/", listener.local_addr()?).parse()?;
        listener.set_nonblocking(true)?;
        let empty = tempfile::tempdir()?;
        let router = Arc::new(RwLock::new(serve(
            empty.path(),
            timezone.clone(),
            web_dir.as_deref(),
        )?));
        let current = router.clone();
        let service = Router::new().fallback_service(tower::service_fn(move |request: Request| {
            let router = current.read().unwrap().clone();
            tower::ServiceExt::oneshot(router, request)
        }));
        tauri::async_runtime::spawn(async move {
            let served =
                async { axum::serve(tokio::net::TcpListener::from_std(listener)?, service).await };
            if let Err(error) = served.await {
                eprintln!("Hahn stopped serving: {error}");
            }
        });
        println!("Hahn: {origin}");
        let client = match &web_dir {
            Some(_) => origin,
            None => app
                .config()
                .build
                .dev_url
                .clone()
                .context("tauri.conf.json sets no build.devUrl")?,
        };
        Ok(Self {
            client,
            web_dir,
            timezone,
            router,
            recording: Mutex::new(None),
            _empty: empty,
        })
    }

    /// Serves `recording` from now on, as the only run, and returns where the client
    /// opens it.
    async fn open(&self, recording: &Path) -> anyhow::Result<Url> {
        if !recording.is_file() {
            bail!("{} is not a file", recording.display());
        }
        let router = serve(recording, self.timezone.clone(), self.web_dir.as_deref())
            .with_context(|| format!("Cannot open {}", recording.display()))?;
        let run = run_id(&router).await?;
        *self.router.write().unwrap() = router;
        *self.recording.lock().unwrap() = Some(recording.to_owned());
        let mut url = self.client.clone();
        url.query_pairs_mut().append_pair("run", &run);
        Ok(url)
    }
}

/// The API for the recordings in `data`, a recording or a directory, with the built
/// client in `web_dir` when there is one.
fn serve(data: &Path, timezone: Option<String>, web_dir: Option<&Path>) -> anyhow::Result<Router> {
    let api = hahn::Builder::new(data).timezone(timezone).router()?;
    Ok(match web_dir {
        Some(dir) => {
            api.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true))
        }
        None => api,
    })
}

/// `dir`, or the client bundled with the application, or the repository's when running
/// from it, as long as it has been built.
fn built_client(app: &AppHandle, dir: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    let candidates = match dir {
        Some(dir) => vec![dir],
        None => vec![
            app.path().resource_dir()?.join("web"),
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../client/dist"),
        ],
    };
    candidates
        .iter()
        .find(|dir| dir.join("index.html").is_file())
        .cloned()
        .ok_or_else(|| {
            anyhow!(
                "{} has no built client. Build it with `npm --prefix client run build`, \
                 or run `npm --prefix desktop run dev`.",
                candidates[0].display()
            )
        })
}

/// The id of the only run `api` serves.
async fn run_id(api: &Router) -> anyhow::Result<String> {
    let request = Request::get("/api/runs").body(Body::empty())?;
    let response = tower::ServiceExt::oneshot(api.clone(), request).await?;
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let runs: serde_json::Value = serde_json::from_slice(&body)?;
    runs["items"][0]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("The recording has no run"))
}

/// Asks for a recording and opens it. Cancelling keeps what is open.
fn pick(app: &AppHandle) {
    let served = app.state::<Served>();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Select a recording")
        .add_filter("MCAP recordings", &["mcap"]);
    if let Some(dir) = served
        .recording
        .lock()
        .unwrap()
        .as_deref()
        .and_then(Path::parent)
    {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = app.get_webview_window(WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    let app = app.clone();
    dialog.pick_file(move |file| {
        if let Some(recording) = file.and_then(|file| file.into_path().ok()) {
            open(&app, recording);
        }
    });
}

/// Serves `recording` and shows it in the window.
fn open(app: &AppHandle, recording: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let served = app.state::<Served>();
        let shown = match served.open(&recording).await {
            Ok(url) => show(&app, url, Some(&recording)),
            Err(error) => Err(error),
        };
        if let Err(error) = shown {
            fail(&app, error);
        }
    });
}

/// Shows the client at `url` with `recording` open, opening the window the first time.
fn show(app: &AppHandle, url: Url, recording: Option<&Path>) -> anyhow::Result<()> {
    let title = match recording {
        Some(recording) => format!(
            "{} — Hahn",
            recording.file_name().unwrap_or_default().to_string_lossy()
        ),
        None => "Hahn".to_owned(),
    };
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.set_title(&title)?;
        window.navigate(url)?;
        return Ok(());
    }
    let origin = url.origin();
    let opener = app.clone();
    let dropped = app.clone();
    let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title(title)
        .inner_size(1440.0, 900.0)
        .min_inner_size(640.0, 480.0)
        // Links to other sites, such as map attributions, open in the default browser
        // so that the window keeps showing Hahn.
        .on_navigation(move |target| {
            if target.origin() == origin {
                return true;
            }
            if let Err(error) = opener.opener().open_url(target.as_str(), None::<&str>) {
                eprintln!("Cannot open {target}: {error}");
            }
            false
        });
    // WebView2 turns off drag and drop inside the page while the app takes dropped
    // files, and the client drags topics and widgets. Elsewhere only files reach the app.
    #[cfg(windows)]
    let builder = builder.disable_drag_drop_handler();
    let window = builder.build()?;
    window.on_window_event(move |event| {
        if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event
            && let Some(recording) = dropped_recording(paths)
        {
            open(&dropped, recording);
        }
    });
    Ok(())
}

/// The first MCAP file among those dropped at once, or else the first of them, which
/// fails to open with the reason.
fn dropped_recording(paths: &[PathBuf]) -> Option<PathBuf> {
    paths
        .iter()
        .find(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mcap"))
        })
        .or(paths.first())
        .cloned()
}

/// Says why something failed. Quits when no window is open, since nothing else would.
fn fail(app: &AppHandle, error: anyhow::Error) {
    eprintln!("{error:#}");
    let mut dialog = app
        .dialog()
        .message(format!("{error:#}"))
        .title("Hahn cannot open the recording")
        .kind(MessageDialogKind::Error);
    if let Some(window) = app.get_webview_window(WINDOW) {
        dialog = dialog.parent(&window);
    }
    let app = app.clone();
    dialog.show(move |_| {
        if app.get_webview_window(WINDOW).is_none() {
            app.exit(1);
        }
    });
}

/// Listens on `port` of 127.0.0.1, or on any free port when it is in use.
fn bind(port: u16) -> io::Result<TcpListener> {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            eprintln!("Port {port} is in use, so the workspace saved on it is not restored.");
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        }
        bound => bound,
    }
}
