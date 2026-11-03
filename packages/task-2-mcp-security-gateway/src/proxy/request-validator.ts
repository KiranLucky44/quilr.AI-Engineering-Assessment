export type JsonRpcId = string | number | null;

export interface JsonRpcRequestEnvelope {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly id?: JsonRpcId;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export interface ValidatedMcpJsonRpcRequest {
  readonly envelope: JsonRpcRequestEnvelope;
  readonly isNotification: boolean;
  readonly id: JsonRpcId | undefined;
  readonly method: string;
  readonly toolName: string | undefined;
}

export type JsonRpcValidationOutcome =
  | {
      readonly valid: true;
      readonly request: ValidatedMcpJsonRpcRequest;
    }
  | {
      readonly valid: false;
      readonly httpStatus: number;
      readonly isNotification: boolean;
      readonly errorEnvelope: JsonRpcErrorEnvelope;
    };

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const MCP_UNAUTHORIZED_TOOL_ERROR = -32001;
export const MCP_DOWNSTREAM_UNAVAILABLE_ERROR = -32002;
export const MCP_DOWNSTREAM_TIMEOUT_ERROR = -32003;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isValidJsonRpcId(value: unknown): value is JsonRpcId {
  if (value === null || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return false;
}

export function buildJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcErrorEnvelope {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

/**
 * Parses and validates a raw HTTP body string as a single JSON-RPC 2.0 MCP request.
 *
 * Batch policy: JSON-RPC batch arrays are explicitly rejected with -32600 (Invalid Request)
 * so every HTTP request maps 1:1 to an auditable authorization decision.
 */
export function parseAndValidateJsonRpcBody(rawBody: string): JsonRpcValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      valid: false,
      httpStatus: 400,
      isNotification: false,
      errorEnvelope: buildJsonRpcError(
        null,
        JSONRPC_PARSE_ERROR,
        'Parse error: malformed JSON body',
      ),
    };
  }

  if (Array.isArray(parsed)) {
    return {
      valid: false,
      httpStatus: 400,
      isNotification: false,
      errorEnvelope: buildJsonRpcError(
        null,
        JSONRPC_INVALID_REQUEST,
        'Invalid Request: JSON-RPC batch requests are not supported',
      ),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      valid: false,
      httpStatus: 400,
      isNotification: false,
      errorEnvelope: buildJsonRpcError(
        null,
        JSONRPC_INVALID_REQUEST,
        'Invalid Request: payload must be a JSON object',
      ),
    };
  }

  const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
  const rawId = hasId ? parsed['id'] : undefined;

  if (hasId && !isValidJsonRpcId(rawId)) {
    return {
      valid: false,
      httpStatus: 400,
      isNotification: false,
      errorEnvelope: buildJsonRpcError(
        null,
        JSONRPC_INVALID_REQUEST,
        'Invalid Request: id must be a string, finite number, or null',
      ),
    };
  }

  const responseId: JsonRpcId = hasId ? (rawId as JsonRpcId) : null;
  const isNotification = !hasId;

  if (parsed['jsonrpc'] !== '2.0') {
    return {
      valid: false,
      httpStatus: 400,
      isNotification: false,
      errorEnvelope: buildJsonRpcError(
        responseId,
        JSONRPC_INVALID_REQUEST,
        'Invalid Request: jsonrpc version must be "2.0"',
      ),
    };
  }

  const method = parsed['method'];
  if (typeof method !== 'string' || method.trim().length === 0) {
    return {
      valid: false,
      httpStatus: 400,
      isNotification: false,
      errorEnvelope: buildJsonRpcError(
        responseId,
        JSONRPC_INVALID_REQUEST,
        'Invalid Request: method must be a non-empty string',
      ),
    };
  }

  const hasParams = Object.prototype.hasOwnProperty.call(parsed, 'params');
  const rawParams = hasParams ? parsed['params'] : undefined;

  if (
    hasParams &&
    rawParams !== undefined &&
    (typeof rawParams !== 'object' || rawParams === null)
  ) {
    return {
      valid: false,
      httpStatus: 200,
      isNotification,
      errorEnvelope: buildJsonRpcError(
        responseId,
        JSONRPC_INVALID_PARAMS,
        'Invalid params: params must be a structured object or array',
      ),
    };
  }

  let toolName: string | undefined;
  if (method === 'tools/call') {
    if (!isPlainObject(rawParams)) {
      return {
        valid: false,
        httpStatus: 200,
        isNotification,
        errorEnvelope: buildJsonRpcError(
          responseId,
          JSONRPC_INVALID_PARAMS,
          'Invalid params: tools/call requires a params object',
        ),
      };
    }

    const candidateName = rawParams['name'];
    if (typeof candidateName !== 'string' || candidateName.trim().length === 0) {
      return {
        valid: false,
        httpStatus: 200,
        isNotification,
        errorEnvelope: buildJsonRpcError(
          responseId,
          JSONRPC_INVALID_PARAMS,
          'Invalid params: tools/call requires a non-empty string params.name',
        ),
      };
    }

    toolName = candidateName;
  }

  const envelope: JsonRpcRequestEnvelope = {
    jsonrpc: '2.0',
    method,
    ...(hasId ? { id: rawId as JsonRpcId } : {}),
    ...(hasParams ? { params: rawParams } : {}),
  };

  return {
    valid: true,
    request: {
      envelope,
      isNotification,
      id: hasId ? (rawId as JsonRpcId) : undefined,
      method,
      toolName,
    },
  };
}
