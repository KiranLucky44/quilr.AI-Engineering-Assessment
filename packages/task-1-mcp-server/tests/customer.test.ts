import { describe, expect, it } from 'vitest';
import { CustomerService } from '../src/services/customer.service.js';

describe('CustomerService', () => {
  const service = new CustomerService();

  it('returns deterministic seeded customer record for CUST-12345', () => {
    const first = service.getCustomerRecord({ customer_id: 'CUST-12345' });
    const second = service.getCustomerRecord({ customer_id: 'CUST-12345' });

    expect(first).toEqual(second);
    expect(first.found).toBe(true);
    if (first.found) {
      expect(first.customer.customer_id).toBe('CUST-12345');
      expect(first.customer.full_name).toBe('Elena Vance');
      expect(first.customer.currency).toBe('USD');
      expect(first.customer.recent_orders.length).toBeGreaterThan(0);
    }
  });

  it('returns deterministic synthetic records for unseeded valid customer IDs', () => {
    const first = service.getCustomerRecord({ customer_id: 'CUST-77777' });
    const second = service.getCustomerRecord({ customer_id: 'CUST-77777' });

    expect(first).toEqual(second);
    expect(first.found).toBe(true);
    if (first.found) {
      expect(first.customer.customer_id).toBe('CUST-77777');
    }
  });

  it('returns found: false for reserved non-existent customer CUST-00000', () => {
    const result = service.getCustomerRecord({ customer_id: 'CUST-00000' });
    expect(result).toEqual({
      found: false,
      customer_id: 'CUST-00000',
      message: 'No customer record exists for CUST-00000.',
    });
  });
});
