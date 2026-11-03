import { resolveDeterministicCustomer, type CustomerRecord } from '../data/mock-customers.js';
import {
  GetCustomerRecordSchema,
  type GetCustomerRecordInput,
} from '../schemas/customer.schema.js';

export type CustomerLookupResult =
  | {
      readonly found: true;
      readonly customer: CustomerRecord;
    }
  | {
      readonly found: false;
      readonly customer_id: string;
      readonly message: string;
    };

export class CustomerService {
  public getCustomerRecord(rawInput: GetCustomerRecordInput): CustomerLookupResult {
    const validated = GetCustomerRecordSchema.parse(rawInput);
    const record = resolveDeterministicCustomer(validated.customer_id);

    if (!record) {
      return {
        found: false,
        customer_id: validated.customer_id,
        message: `No customer record exists for ${validated.customer_id}.`,
      };
    }

    return {
      found: true,
      customer: record,
    };
  }
}
