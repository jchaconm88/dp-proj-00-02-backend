export interface CustomerInput {
  external_id: string;
  name: string;
  email?: string;
  phone?: string;
  document_type?: string;
  document_number?: string;
  address?: string;
}

export function toCustomerRecord(input: CustomerInput, companyId: string, accountId: string): Record<string, unknown> {
  return {
    name: input.name,
    email: input.email ?? "",
    phone: input.phone ?? "",
    documentType: input.document_type ?? "",
    documentNumber: input.document_number ?? "",
    address: input.address ?? "",
    companyId,
    accountId,
    externalIds: { woocommerce: input.external_id },
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
