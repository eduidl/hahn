use hahn::{
    DataTypeDef, ElementDef, FieldDef, FieldDefs, Format, MessageTimes, Source, SourceInfo,
    TimeRange, TopicMeta, Value, Visit,
};
use std::{path::Path, sync::Arc};

pub(crate) fn defs(fields: Vec<(&str, DataTypeDef)>) -> FieldDefs {
    FieldDefs::new(
        fields
            .into_iter()
            .map(|(name, data_type)| FieldDef::new(name, data_type, false))
            .collect(),
    )
}

