import { describe, expect, it } from 'vitest';
import { RefundService } from '../src/services/refund.service.js';

describe('RefundService', () => {
  const service = new RefundService('2026-02-01T00:00:00.000Z');

  it('produces deterministic simulated refund results with REF- prefix', () => {
    const input = {
      customer_id: 'CUST-12345',
      amount: 150.5,
      reason: 'Duplicate payment',
    };

    const first = service.triggerRefund(input);
    const second = service.triggerRefund(input);

    expect(first).toEqual(second);
    expect(first.simulated).toBe(true);
    expect(first.status).toBe('APPROVED');
    expect(first.refund_id).toMatch(/^REF-[A-F0-9]{10}$/);
    expect(first.amount_usd).toBe(150.5);
    expect(first.reason).toBe('Duplicate payment');
  });

  it('normalizes surrounding whitespace in reason deterministically', () => {
    const clean = service.triggerRefund({
      customer_id: 'CUST-12345',
      amount: 150.5,
      reason: 'Duplicate payment',
    });
    const padded = service.triggerRefund({
      customer_id: 'CUST-12345',
      amount: 150.5,
      reason: '   Duplicate payment   ',
    });

    expect(padded.refund_id).toBe(clean.refund_id);
  });

  it('declines simulated refund when customer does not exist (CUST-00000)', () => {
    const result = service.triggerRefund({
      customer_id: 'CUST-00000',
      amount: 50,
      reason: 'Service cancellation credit',
    });

    expect(result.simulated).toBe(true);
    expect(result.status).toBe('REJECTED_CUSTOMER_NOT_FOUND');
    expect(result.refund_id).toBeNull();
  });
});
