fn main() {
    // Commands the client in the window may call; capabilities/ grants them.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["select_recording"])),
    )
    .expect("failed to run the Tauri build script");
}
