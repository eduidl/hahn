/** One open recording as loaded from the server. */
export type LoadedSource = {
  info: Info | null;
  topics: Topic[];
  error: string;
  loading: boolean;
};

