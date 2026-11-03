import { describe, expect, it } from 'vitest';
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  parseAndValidateJsonRpcBody,
} from '../src/proxy/request-validator.js';

describe('JSON-RPC 2.0 Request Validator (Task 2)', () => {
  it('parses valid single JSON-RPC 2.0 requests and preserves id, method, and params', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-42',
      method: 'tools/call',
      params: { name: 'get_customer_record', arguments: { customer_id: 'CUST-12345' } },
    });

    const outcome = parseAndValidateJsonRpcBody(raw);
    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.request.isNotification).toBe(false);
      expect(outcome.request.id).toBe('req-42');
      expect(outcome.request.method).toBe('tools/call');
      expect(outcome.request.toolName).toBe('get_customer_record');
      expect(outcome.request.envelope).toEqual({
        jsonrpc: '2.0',
        id: 'req-42',
        method: 'tools/call',
        params: { name: 'get_customer_record', arguments: { customer_id: 'CUST-12345' } },
      });
    }
  });

  it('recognizes JSON-RPC notifications without inventing an id', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    const outcome = parseAndValidateJsonRpcBody(raw);
    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.request.isNotification).toBe(true);
      expect(outcome.request.id).toBeUndefined();
      expect('id' in outcome.request.envelope).toBe(false);
    }
  });

  it('rejects malformed JSON with -32700 Parse Error', () => {
    const outcome = parseAndValidateJsonRpcBody('{bad json');
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) {
      expect(outcome.errorEnvelope.error.code).toBe(JSONRPC_PARSE_ERROR);
      expect(outcome.errorEnvelope.id).toBeNull();
    }
  });

  it('explicitly rejects JSON-RPC batch arrays with -32600 Invalid Request', () => {
    const batch = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const outcome = parseAndValidateJsonRpcBody(batch);
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) {
      expect(outcome.errorEnvelope.error.code).toBe(JSONRPC_INVALID_REQUEST);
    }
  });

  it('rejects invalid jsonrpc version, invalid id types, or missing method', () => {
    expect(
      parseAndValidateJsonRpcBody(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'tools/list' }))
        .valid,
    ).toBe(false);
    expect(
      parseAndValidateJsonRpcBody(
        JSON.stringify({ jsonrpc: '2.0', id: { bad: true }, method: 'tools/list' }),
      ).valid,
    ).toBe(false);
    expect(
      parseAndValidateJsonRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: '' })).valid,
    ).toBe(false);
  });

  it('rejects tools/call when params or params.name is missing or invalid with -32602', () => {
    const missingName = parseAndValidateJsonRpcBody(
      JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: {} }),
    );
    expect(missingName.valid).toBe(false);
    if (!missingName.valid) {
      expect(missingName.errorEnvelope.error.code).toBe(JSONRPC_INVALID_PARAMS);
      expect(missingName.errorEnvelope.id).toBe(99);
    }
  });
});
