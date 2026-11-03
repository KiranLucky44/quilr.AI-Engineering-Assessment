import { describe, expect, it } from 'vitest';
import { GetCustomerRecordSchema } from '../src/schemas/customer.schema.js';
import { TriggerRefundSchema } from '../src/schemas/refund.schema.js';

describe('Task 1 Zod Strict Input Schemas', () => {
  describe('GetCustomerRecordSchema', () => {
    it('accepts valid customer IDs matching ^CUST-[0-9]{5}$', () => {
      expect(GetCustomerRecordSchema.parse({ customer_id: 'CUST-12345' })).toEqual({
        customer_id: 'CUST-12345',
      });
      expect(GetCustomerRecordSchema.parse({ customer_id: 'CUST-00001' })).toEqual({
        customer_id: 'CUST-00001',
      });
      expect(GetCustomerRecordSchema.parse({ customer_id: 'CUST-99999' })).toEqual({
        customer_id: 'CUST-99999',
      });
    });

    it('rejects malformed, empty, missing, or non-string customer IDs', () => {
      const invalidPayloads: unknown[] = [
        {},
        { customer_id: '' },
        { customer_id: null },
        { customer_id: 12345 },
        { customer_id: 'cust-12345' },
        { customer_id: 'CUST-1234' },
        { customer_id: 'CUST-123456' },
        { customer_id: 'CUST-1234A' },
        { customer_id: ' CUST-12345' },
        { customer_id: 'CUST-12345 ' },
        { customer_id: 'USER-12345' },
      ];

      for (const payload of invalidPayloads) {
        const result = GetCustomerRecordSchema.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it('rejects unexpected extra object properties', () => {
      const result = GetCustomerRecordSchema.safeParse({
        customer_id: 'CUST-12345',
        include_secret_notes: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('TriggerRefundSchema', () => {
    it('accepts valid refund inputs', () => {
      const parsed = TriggerRefundSchema.parse({
        customer_id: 'CUST-12345',
        amount: 150.5,
        reason: 'Duplicate payment',
      });

      expect(parsed).toEqual({
        customer_id: 'CUST-12345',
        amount: 150.5,
        reason: 'Duplicate payment',
      });
    });

    it('rejects negative, zero, NaN, Infinity, and non-numeric refund amounts', () => {
      const invalidAmounts: unknown[] = [
        0,
        -0.01,
        -150,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        '150.50',
        null,
        undefined,
      ];

      for (const amount of invalidAmounts) {
        const result = TriggerRefundSchema.safeParse({
          customer_id: 'CUST-12345',
          amount,
          reason: 'Duplicate payment on invoice',
        });
        expect(result.success).toBe(false);
      }
    });

    it('rejects reasons shorter than 10 characters after trimming', () => {
      const invalidReasons: unknown[] = [
        '',
        'short',
        '123456789',
        '     short     ',
        '   9chars   '.slice(0, 11), // '   9chars  ' -> trimmed length 6
        null,
        42,
      ];

      for (const reason of invalidReasons) {
        const result = TriggerRefundSchema.safeParse({
          customer_id: 'CUST-12345',
          amount: 25.0,
          reason,
        });
        expect(result.success).toBe(false);
      }
    });

    it('accepts reasons with at least 10 characters after trimming even with surrounding whitespace', () => {
      const result = TriggerRefundSchema.safeParse({
        customer_id: 'CUST-12345',
        amount: 25.0,
        reason: '   1234567890   ',
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown properties on refund input', () => {
      const result = TriggerRefundSchema.safeParse({
        customer_id: 'CUST-12345',
        amount: 150.5,
        reason: 'Duplicate payment',
        bypass_approval: true,
      });
      expect(result.success).toBe(false);
    });
  });
});
