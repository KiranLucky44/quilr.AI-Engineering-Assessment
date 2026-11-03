import type { Role } from '../auth/roles.js';
import { MCP_UNAUTHORIZED_TOOL_ERROR } from './request-validator.js';

export const ADMIN_TOOL_PREFIX = 'admin_';

export type AuthorizationDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly errorCode: typeof MCP_UNAUTHORIZED_TOOL_ERROR;
      readonly errorMessage: 'Unauthorized Tool Call';
    };

export function isAdminProtectedTool(toolName: string): boolean {
  return toolName.startsWith(ADMIN_TOOL_PREFIX);
}

/**
 * Evaluates MCP method and tool-level authorization policy:
 * - `tools/list` is allowed for both `viewer` and `admin` without per-tool filtering.
 * - `tools/call` on any tool prefixed with `admin_` requires the `admin` role.
 * - Non-admin tools are accessible to both `viewer` and `admin`.
 */
export function evaluateToolAuthorization(
  role: Role,
  method: string,
  toolName?: string,
): AuthorizationDecision {
  if (method === 'tools/list') {
    return { allowed: true };
  }

  if (method === 'tools/call' && toolName !== undefined) {
    if (isAdminProtectedTool(toolName) && role !== 'admin') {
      return {
        allowed: false,
        errorCode: MCP_UNAUTHORIZED_TOOL_ERROR,
        errorMessage: 'Unauthorized Tool Call',
      };
    }
  }

  return { allowed: true };
}
