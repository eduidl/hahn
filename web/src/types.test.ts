const topics: Topic[] = [
  {
    topic: "/pose",
    schema_name: "Pose",
    fields: [
      { path: ["position", "x"], data_type: "f64" },
      ...["string", "bool", "enum", "u8[]", "struct"].map((data_type) => ({
        path: [data_type],
        data_type,
      })),
    ],
    message_count: 10,
    error: null,
  },
  {
    topic: "/unreadable",
    schema_name: null,
    fields: [],
    message_count: 10,
    error: "No decoder",
  },
];

