import { z } from 'zod';

export const CUSTOMER_ID_PATTERN = /^CUST-[0-9]{5}$/;

export const CustomerIdSchema = z
  .string({
    required_error: 'customer_id is required',
    invalid_type_error: 'customer_id must be a string',
  })
  .regex(CUSTOMER_ID_PATTERN, 'customer_id must match format ^CUST-[0-9]{5}$ (e.g., CUST-12345)');

export const GetCustomerRecordInputShape = {
  customer_id: CustomerIdSchema.describe(
    'Unique customer identifier matching ^CUST-[0-9]{5}$ (e.g., CUST-12345)',
  ),
} as const;

export const GetCustomerRecordSchema = z.object(GetCustomerRecordInputShape).strict();

export type GetCustomerRecordInput = z.infer<typeof GetCustomerRecordSchema>;
