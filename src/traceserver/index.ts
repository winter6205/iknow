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
  MAX_TRACE_BYTES_FOR_CONTAINS,
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
  sessionsByRecency,
  type SessionSummary,
} from "./sessions.js";
export {
  emptyResponseEnvelope,
  toResponseEnvelope,
  toQueryTracePage,
  type ResponseEnvelope,
  type QueryTracePage,
} from "./envelope.js";
export {
  dereferenceSystemBody,
  dereferenceTraceMessages,
  projectToolResults,
  projectToolResultsFromTrace,
  TOOL_RESULT_PREVIEW_CAP,
  type BlobReference,
  type ProjectedToolResult,
  type ReadBlob,
  type ToolResultProjection,
  type TraceMessageDereferenceOptions,
} from "./project-tool-results.js";
export {
  TRACE_RECORD_ID_KEYS,
  TRACE_RECORD_ID_SCAN_LIMIT,
  lookupRecordById,
  projectRecordBase,
  type RecordLookupResult,
  type RecordMatch,
} from "./record-lookup.js";
export {
  TRACE_OUTPUT_BACKSTOP,
  TRACE_BACKSTOP_MARKER,
  applyTraceOutputBackstop,
} from "./output-backstop.js";
export {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_DESCRIPTION,
  QUERY_TRACE_PREVIEW_CAP,
  type QueryTraceCoreHandler,
  type QueryTraceCoreOptions,
} from "./query-trace-core.js";
export {
  createGetRecordCore,
  GET_RECORD_DEFAULT_COUNT,
  GET_RECORD_MAX_COUNT,
  GET_RECORD_DESCRIPTION,
  GET_RECORD_DETAIL_VALUES,
  type GetRecordCoreHandler,
  type GetRecordCoreOptions,
} from "./get-record-core.js";
export {
  createListSessionsCore,
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  LIST_SESSIONS_DESCRIPTION,
  type ListSessionsCoreHandler,
  type ListSessionsCoreOptions,
  type ListSessionsPage,
} from "./list-sessions-core.js";
export {
  TraceQueryRecordScanError,
  TraceQueryValidationError,
  TraceRecordNotFoundError,
  TraceSessionNotFoundError,
  TraceWindowOverflowError,
} from "./query-trace-errors.js";
export {
  createTraceRouter,
  startTraceServe,
  type TraceRouter,
  type TraceRouterOptions,
  type TraceServeOptions,
  type TraceListeningServer,
} from "./serve.js";
