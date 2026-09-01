/** traceserver barrel — read side of the JSONL trace inspection panel. */
export {
  TRACE_RECORD_TYPES,
  TraceReadError,
  type TraceRecordType,
  type TraceRecordRow,
  type TraceQuery,
  type TraceQueryResult,
} from "./types.js";
export { TRACE_FIELD_DEFS, type TraceFieldDef } from "./fields.js";
export {
  createJsonlTraceReader,
  MAX_TRACE_BYTES,
  type JsonlTraceReader,
  type JsonlTraceReaderOptions,
} from "./reader.js";
export {
  handleTracesRequest,
  handleSessionsRequest,
  type TracesRequestOpts,
} from "./http.js";
export {
  listSessions,
  newestConversationId,
  type SessionSummary,
} from "./sessions.js";
export {
  emptyResponseEnvelope,
  toResponseEnvelope,
  type ResponseEnvelope,
} from "./envelope.js";
export {
  dereferenceTraceMessages,
  projectToolResults,
  projectToolResultsFromTrace,
  TOOL_RESULT_PREVIEW_CAP,
  type BlobReference,
  type ReadBlob,
  type ToolResultProjection,
  type TraceMessageDereferenceOptions,
} from "./project-tool-results.js";
export {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_MAX_RECORD_ID_SCAN,
  QUERY_TRACE_PREVIEW_CAP,
  QUERY_TRACE_RESPONSE_CAP,
  type QueryTraceCoreHandler,
  type QueryTraceCoreOptions,
} from "./query-trace-core.js";
export {
  TraceQueryRecordScanError,
  TraceQueryValidationError,
} from "./query-trace-errors.js";
export {
  createTraceRouter,
  startTraceServe,
  type TraceRouter,
  type TraceRouterOptions,
  type TraceServeOptions,
  type TraceListeningServer,
} from "./serve.js";
