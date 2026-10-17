/// First backwards search window of the default [`Source::latest_at`]; it
/// doubles until the recording start. Kept short so frequent large messages
/// (point clouds) are not decoded in bulk.
const FIRST_WINDOW_NS: u64 = 100_000_000;

