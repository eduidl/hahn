//! The binary framing of view responses.
//!
//! A frame is `u32 header_len | u32 payload_len | header | padding | payload`, in
//! little endian. The payload and every blob in it start on an 8-byte boundary of
//! the frame, so a client can view them as typed arrays without copying.

use axum::body::Bytes;
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;

const ALIGNMENT: usize = 8;
const ZEROS: [u8; ALIGNMENT] = [0; ALIGNMENT];
const LENGTHS: usize = 8;

pub(crate) const CONTENT_TYPE: &str = "application/vnd.hahn.frames";

fn padding(length: usize) -> usize {
    length.next_multiple_of(ALIGNMENT) - length
}

/// The binary part of a frame. Blobs are shared with the decoded message, not copied.
#[derive(Default)]
pub(crate) struct Payload {
    blobs: Vec<Arc<[u8]>>,
    length: usize,
}

impl Payload {
    /// Appends `blob` and returns the reference to it for the frame's JSON value.
    pub(crate) fn add(&mut self, blob: Arc<[u8]>) -> serde_json::Value {
        let offset = self.length;
        let length = blob.len();
        self.length += length + padding(length);
        self.blobs.push(blob);
        json!({ "$blob": { "offset": offset, "length": length } })
    }

    pub(crate) fn fits(&self) -> bool {
        u32::try_from(self.length).is_ok()
    }
}

/// The chunks of one frame. The caller must have checked [`Payload::fits`].
pub(crate) fn encode<H: Serialize>(header: &H, payload: Payload) -> anyhow::Result<Vec<Bytes>> {
    let header = serde_json::to_vec(header)?;
    let mut head = Vec::with_capacity(LENGTHS + header.len() + ALIGNMENT);
    head.extend_from_slice(&u32::try_from(header.len())?.to_le_bytes());
    head.extend_from_slice(&u32::try_from(payload.length)?.to_le_bytes());
    head.extend_from_slice(&header);
    head.extend_from_slice(&ZEROS[..padding(head.len())]);
    let mut chunks = vec![Bytes::from(head)];
    for blob in payload.blobs {
        let pad = padding(blob.len());
        chunks.push(Bytes::from_owner(blob));
        if pad > 0 {
            chunks.push(Bytes::from_static(&ZEROS[..pad]));
        }
    }
    Ok(chunks)
}
