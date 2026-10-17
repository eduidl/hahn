export const typeLabel = (topic: Topic, field: Field) =>
  field.type_name
    ? displayType(field.type_name)
    : displayType(field.data_type, topic.schema_encoding);

