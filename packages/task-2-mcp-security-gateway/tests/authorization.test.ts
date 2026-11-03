import { describe, expect, it } from 'vitest';
import {
  evaluateToolAuthorization,
  isAdminProtectedTool,
} from '../src/proxy/authorization-policy.js';

describe('Authorization Policy (Task 2 RBAC)', () => {
  it('identifies tools prefixed with admin_ as admin-protected', () => {
    expect(isAdminProtectedTool('admin_reset_key')).toBe(true);
    expect(isAdminProtectedTool('admin_delete_customer')).toBe(true);
    expect(isAdminProtectedTool('admin_update_config')).toBe(true);
    expect(isAdminProtectedTool('get_customer_record')).toBe(false);
    expect(isAdminProtectedTool('administrator_info')).toBe(false);
    expect(isAdminProtectedTool('ADMIN_reset_key')).toBe(false);
  });

  it('allows tools/list for both viewer and admin roles', () => {
    expect(evaluateToolAuthorization('viewer', 'tools/list')).toEqual({ allowed: true });
    expect(evaluateToolAuthorization('admin', 'tools/list')).toEqual({ allowed: true });
  });

  it('allows viewer and admin to call non-admin tools', () => {
    expect(evaluateToolAuthorization('viewer', 'tools/call', 'get_customer_record')).toEqual({
      allowed: true,
    });
    expect(evaluateToolAuthorization('admin', 'tools/call', 'get_customer_record')).toEqual({
      allowed: true,
    });
  });

  it('denies viewer access to admin_* tools with code -32001 and message Unauthorized Tool Call', () => {
    for (const tool of ['admin_reset_key', 'admin_delete_customer', 'admin_update_config']) {
      expect(evaluateToolAuthorization('viewer', 'tools/call', tool)).toEqual({
        allowed: false,
        errorCode: -32001,
        errorMessage: 'Unauthorized Tool Call',
      });
    }
  });

  it('allows admin access to admin_* tools', () => {
    for (const tool of ['admin_reset_key', 'admin_delete_customer', 'admin_update_config']) {
      expect(evaluateToolAuthorization('admin', 'tools/call', tool)).toEqual({
        allowed: true,
      });
    }
  });
});
