/**
 * Types and interfaces for Filterable Attribute Types CRUD.
 * Follows the same pattern as variant-attribute-types.helpers.ts.
 */

// ─── Record (Firestore document shape) ───────────────────────────────────────

export interface FilterableAttributeTypeRecord {
  id: string;
  code: string;
  label: string;
  values: string[];
  sortOrder: number;
  active: boolean;
  companyId: string;
  accountId: string;
  createAt?: unknown;
  createBy?: string;
  updateAt?: unknown;
  updateBy?: string;
}

// ─── Request interfaces ──────────────────────────────────────────────────────

/** Body for POST /inventory/filterable-attribute-types */
export interface FilterableAttributeTypeCreateRequest {
  companyId: string;
  code: string;
  label: string;
  values: string[];
  sortOrder: number;
  active: boolean;
}

/** Body for PUT /inventory/filterable-attribute-types/:id */
export type FilterableAttributeTypeUpdateRequest = Partial<
  Omit<FilterableAttributeTypeRecord, "id" | "companyId" | "accountId" | "createAt" | "createBy" | "updateAt" | "updateBy">
>;

// ─── Response interfaces ─────────────────────────────────────────────────────

/** Response for GET /inventory/filterable-attribute-types */
export interface FilterableAttributeTypeListResponse {
  items: FilterableAttributeTypeRecord[];
  total: number;
}

/** Response for POST /inventory/filterable-attribute-types */
export interface FilterableAttributeTypeCreateResponse {
  ok: true;
  id: string;
}

/** Response for PUT /inventory/filterable-attribute-types/:id */
export interface FilterableAttributeTypeUpdateResponse {
  ok: true;
}

/** Response for DELETE /inventory/filterable-attribute-types/:id */
export interface FilterableAttributeTypeDeleteResponse {
  ok: true;
}

/** Error response shape */
export interface FilterableAttributeTypeErrorResponse {
  error: string;
  message?: string;
}

// ─── Validation constants ────────────────────────────────────────────────────

export const FILTERABLE_ATTRIBUTE_TYPE_CODE_RE = /^[a-z0-9_-]+$/;
export const FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH = 50;
export const FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH = 100;
export const FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT = 200;
export const FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH = 100;
export const FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN = 0;
export const FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX = 9999;
