//! Maps the data directory onto the API's runs and groups.
//!
//! Each entry directly under the root is one run: a file is a run with a single
//! group, a directory is a run whose files are its groups. A directory holding a
//! rosbag2 `metadata.yaml` is a bag: its `<prefix>_<n>.<ext>` files are the
//! segments of one group. Elsewhere such files stay separate groups, since
//! `cam_0.mcap` and `cam_1.mcap` may just as well be two cameras.

use crate::{
    source::{self, Format, Source},
    view::{Converter, TfIndex, ViewIndex},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

#[derive(Serialize)]
pub(crate) struct Run {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) timezone: Option<String>,
    pub(crate) groups: Vec<Arc<Group>>,
    #[serde(skip)]
    tf: OnceLock<Arc<TfIndex>>,
}

impl Run {
    /// Reads the transform topics of all groups on first use, wherever the server put
    /// them. A group that cannot be opened reports that itself, and must not take the
    /// others' frames with it. Blocks, so call it inside `blocking`.
    pub(crate) fn tf(&self) -> anyhow::Result<Arc<TfIndex>> {
        if let Some(tf) = self.tf.get() {
            return Ok(tf.clone());
        }
        let sources = self.groups.iter().filter_map(|group| group.source().ok());
        let tf = Arc::new(TfIndex::build(sources)?);
        Ok(self.tf.get_or_init(|| tf).clone())
    }
}

#[derive(Serialize)]
pub(crate) struct Group {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) default_open: bool,
    #[serde(skip)]
    segments: Vec<PathBuf>,
    #[serde(skip)]
    opener: &'static dyn Format,
    /// Opened on first use; failures are not cached so each request reports them.
    #[serde(skip)]
    source: OnceLock<Arc<dyn Source>>,
    #[serde(skip)]
    views: OnceLock<Arc<ViewIndex>>,
}

impl Group {
    fn new(name: String, segments: Vec<PathBuf>, opener: &'static dyn Format) -> Arc<Self> {
        Arc::new(Self {
            id: encode(&name),
            name,
            default_open: true,
            segments,
            opener,
            source: OnceLock::new(),
            views: OnceLock::new(),
        })
    }

    /// Opens the recording on first use. Blocks, so call it inside `blocking`.
    pub(crate) fn source(&self) -> anyhow::Result<Arc<dyn Source>> {
        if let Some(source) = self.source.get() {
            return Ok(source.clone());
        }
        let source = match self.segments.as_slice() {
            [path] => self.opener.open(path)?,
            paths => source::open_segments(self.opener, paths)?,
        };
        Ok(self.source.get_or_init(|| source).clone())
    }

    /// Built on first use like the source. Blocks, so call it inside `blocking`.
    pub(crate) fn views(
        &self,
        converters: &[Arc<dyn ViewConverter>],
    ) -> anyhow::Result<Arc<ViewIndex>> {
        if let Some(views) = self.views.get() {
            return Ok(views.clone());
        }
        let views = Arc::new(ViewIndex::build(&*self.source()?, converters)?);
        Ok(self.views.get_or_init(|| views).clone())
    }
}

/// Ids are stable across restarts, and safe in a URL whatever the file is called.
fn encode(name: &str) -> String {
    name.bytes().map(|b| format!("{b:02x}")).collect()
}

fn format_of(path: &Path) -> Option<&'static dyn Format> {
    source::formats().iter().find(|f| f.accepts(path)).copied()
}

fn relative(path: &Path, root: &Path) -> anyhow::Result<String> {
    Ok(path.strip_prefix(root)?.to_string_lossy().into_owned())
}

/// Entries of `dir` by path, so that discovery is deterministic. Symlinks are left
/// to the caller's file-type checks: they are never followed out of the root.
fn entries(dir: &Path) -> anyhow::Result<Vec<std::fs::DirEntry>> {
    let mut entries = std::fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.path());
    Ok(entries)
}

fn is_bag(dir: &Path) -> bool {
    dir.join("metadata.yaml").is_file()
}

pub(crate) fn discover(
    root: &Path,
    timezone: Option<String>,
    formats: &[Arc<dyn Format>],
) -> anyhow::Result<Vec<Run>> {
    let mut runs = Vec::new();
    for entry in entries(root)? {
        let (path, kind) = (entry.path(), entry.file_type()?);
        let name = relative(&path, root)?;
        let groups = if kind.is_dir() {
            let mut groups = Vec::new();
            if is_bag(&path) {
                bag_groups(formats, &path, &name, &mut groups)?;
            } else {
                dir_groups(formats, &path, &path, &mut groups)?;
            }
            groups
        } else if kind.is_file()
            && let Some(format) = format_of(formats, &path)
        {
            vec![Group::new(name.clone(), vec![path], format)]
        } else {
            continue;
        };
        if !groups.is_empty() {
            runs.push(Run {
                id: encode(&name),
                name,
                timezone: timezone.clone(),
                groups,
                tf: OnceLock::new(),
            });
        }
    }
    Ok(runs)
}

fn dir_groups(
    formats: &[Arc<dyn Format>],
    dir: &Path,
    run: &Path,
    groups: &mut Vec<Arc<Group>>,
) -> anyhow::Result<()> {
    for entry in entries(dir)? {
        let (path, kind) = (entry.path(), entry.file_type()?);
        if kind.is_dir() {
            if is_bag(&path) {
                bag_groups(formats, &path, &relative(&path, run)?, groups)?;
            } else {
                dir_groups(formats, &path, run, groups)?;
            }
        } else if kind.is_file()
            && let Some(format) = format_of(formats, &path)
        {
            groups.push(Group::new(relative(&path, run)?, vec![path], format));
        }
    }
    Ok(())
}

/// Splits `<prefix>_<n>.<ext>` into the name of its series and its position.
fn segment_of(file_name: &str) -> Option<(String, u64)> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    let (prefix, number) = stem.rsplit_once('_')?;
    Some((format!("{prefix}.{ext}"), number.parse().ok()?))
}

/// A bag's segment series, normally just one, named after the bag.
fn bag_groups(
    formats: &[Arc<dyn Format>],
    bag: &Path,
    name: &str,
    groups: &mut Vec<Arc<Group>>,
) -> anyhow::Result<()> {
    let mut series: BTreeMap<String, Vec<(u64, PathBuf)>> = BTreeMap::new();
    for entry in entries(bag)? {
        let path = entry.path();
        if !entry.file_type()?.is_file() || format_of(formats, &path).is_none() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let (key, number) = segment_of(&file_name).unwrap_or((file_name, 0));
        series.entry(key).or_default().push((number, path));
    }
    let only = series.len() == 1;
    for (key, mut segments) in series {
        segments.sort();
        let paths: Vec<_> = segments.into_iter().map(|(_, path)| path).collect();
        let format = format_of(formats, &paths[0]).expect("filtered above");
        let name = if only {
            name.to_owned()
        } else {
            format!("{name}/{key}")
        };
        groups.push(Group::new(name, paths, format));
    }
    Ok(())
}
