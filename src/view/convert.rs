//! Converters from recorded message types to the protocol's fixed kinds.

use super::frame::Payload;
use anyhow::{Context, bail, ensure};
use mcapdecode::core::{DataTypeDef, FieldDefs, Value};
use serde_json::json;
use std::sync::Arc;

/// Whether `defs` has a field `name` whose type passes `check`.
pub(crate) fn has(defs: &FieldDefs, name: &str, check: fn(&DataTypeDef) -> bool) -> bool {
    defs.iter()
        .any(|field| field.name == name && check(&field.element.data_type))
}

fn is_list(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::List(_) | DataTypeDef::BoundedList(..) | DataTypeDef::Array(..)
    )
}

fn is_bytes(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::Bytes | DataTypeDef::Uint8List | DataTypeDef::BoundedUint8List(_)
    )
}

pub(crate) fn is_string(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::String | DataTypeDef::BoundedString(_)
    )
}

fn is_number(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::I8
            | DataTypeDef::I16
            | DataTypeDef::I32
            | DataTypeDef::I64
            | DataTypeDef::U8
            | DataTypeDef::U16
            | DataTypeDef::U32
            | DataTypeDef::U64
            | DataTypeDef::F32
            | DataTypeDef::F64
    )
}

