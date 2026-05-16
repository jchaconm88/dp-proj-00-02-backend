import type {
  ValidationResult,
  ValidationError,
  DeletionCheck,
  CardDefinition,
  ChartDefinition,
} from "./dashboard.types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const METRIC_KEY_REGEX = /^[a-zA-Z0-9-]+$/;
const MAX_KEY_LENGTH = 64;
const MAX_LABEL_LENGTH = 120;

const METRIC_TYPES = ["entityCount", "sum", "ratio", "custom"] as const;
const MEASURE_TYPES = ["counterMonthly", "gaugeCurrent"] as const;
const VALUE_FORMATS = ["number", "currency", "percentage", "bytes"] as const;
const DELTA_TYPES = ["count", "sum", "custom"] as const;
const CHART_TYPES = ["bar", "line", "pie", "doughnut"] as const;
const GROUP_BY_OPTIONS = ["daily", "weekly", "monthly"] as const;
const TARGET_OPTIONS = ["admin", "web", "both"] as const;

// ─── Payload Interfaces ──────────────────────────────────────────────────────

export interface CreateMetricPayload {
  metricKey?: string;
  label?: string;
  type?: string;
  measureType?: string;
  valueFormat?: string;
  source?: { collectionName?: string };
  active?: boolean;
  target?: string;
  numeratorMetricKey?: string;
  denominatorMetricKey?: string;
  readonly?: boolean;
  [key: string]: unknown;
}

export interface CreateCardPayload {
  cardKey?: string;
  metricKey?: string;
  title?: string;
  icon?: string;
  accentClass?: string;
  order?: number;
  visible?: boolean;
  active?: boolean;
  target?: string;
  readonly?: boolean;
  [key: string]: unknown;
}

export interface CreateChartPayload {
  chartKey?: string;
  title?: string;
  chartType?: string;
  metricKeys?: string[];
  groupBy?: string;
  target?: string;
  permissionModule?: string;
  readonly?: boolean;
  [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addError(
  errors: ValidationError[],
  field: string,
  code: string,
  message: string
): void {
  errors.push({ field, code, message });
}

function toResult(errors: ValidationError[]): ValidationResult {
  if (errors.length === 0) return { valid: true };
  return { valid: false, errors };
}

// ─── validateMetric ──────────────────────────────────────────────────────────

/**
 * Validates a metric definition payload.
 * @param payload - The metric payload to validate
 * @param existingKeys - Array of existing metricKey values (for uniqueness check)
 */
export function validateMetric(
  payload: CreateMetricPayload,
  existingKeys: string[]
): ValidationResult {
  const errors: ValidationError[] = [];

  // Reject readonly items
  if (payload.readonly === true) {
    addError(errors, "readonly", "readonly_item", "No se puede modificar un item de solo lectura");
    return toResult(errors);
  }

  // metricKey: required, alphanumeric+hyphens, max 64, unique
  if (!payload.metricKey || payload.metricKey.trim() === "") {
    addError(errors, "metricKey", "required", "metricKey es requerido");
  } else {
    const key = payload.metricKey;
    if (key.length > MAX_KEY_LENGTH) {
      addError(errors, "metricKey", "max_length", `metricKey no debe exceder ${MAX_KEY_LENGTH} caracteres`);
    }
    if (!METRIC_KEY_REGEX.test(key)) {
      addError(errors, "metricKey", "invalid_format", "metricKey solo permite caracteres alfanuméricos y guiones");
    }
    if (existingKeys.includes(key)) {
      addError(errors, "metricKey", "duplicate", "metricKey ya existe");
    }
  }

  // label: required, max 120
  if (!payload.label || payload.label.trim() === "") {
    addError(errors, "label", "required", "label es requerido");
  } else if (payload.label.length > MAX_LABEL_LENGTH) {
    addError(errors, "label", "max_length", `label no debe exceder ${MAX_LABEL_LENGTH} caracteres`);
  }

  // type: required, enum
  if (!payload.type || payload.type.trim() === "") {
    addError(errors, "type", "required", "type es requerido");
  } else if (!(METRIC_TYPES as readonly string[]).includes(payload.type)) {
    addError(errors, "type", "invalid_enum", `type debe ser uno de: ${METRIC_TYPES.join(", ")}`);
  }

  // measureType: required, enum
  if (!payload.measureType || payload.measureType.trim() === "") {
    addError(errors, "measureType", "required", "measureType es requerido");
  } else if (!(MEASURE_TYPES as readonly string[]).includes(payload.measureType)) {
    addError(errors, "measureType", "invalid_enum", `measureType debe ser uno de: ${MEASURE_TYPES.join(", ")}`);
  }

  // valueFormat: required, enum
  if (!payload.valueFormat || payload.valueFormat.trim() === "") {
    addError(errors, "valueFormat", "required", "valueFormat es requerido");
  } else if (!(VALUE_FORMATS as readonly string[]).includes(payload.valueFormat)) {
    addError(errors, "valueFormat", "invalid_enum", `valueFormat debe ser uno de: ${VALUE_FORMATS.join(", ")}`);
  }

  // source.collectionName: required
  if (!payload.source || !payload.source.collectionName || payload.source.collectionName.trim() === "") {
    addError(errors, "source.collectionName", "required", "source.collectionName es requerido");
  }

  // source.deltaType: validate enum
  const rawDeltaType = (payload.source as any)?.deltaType;
  if (rawDeltaType && !(DELTA_TYPES as readonly string[]).includes(rawDeltaType)) {
    addError(errors, "source.deltaType", "invalid_enum", `deltaType debe ser uno de: ${DELTA_TYPES.join(", ")}`);
  }

  // source.fieldName: required when deltaType = "sum"
  if (rawDeltaType === "sum") {
    const rawFieldName = (payload.source as any)?.fieldName;
    if (!rawFieldName || String(rawFieldName).trim() === "") {
      addError(errors, "source.fieldName", "required", "fieldName es requerido cuando deltaType es sum");
    }
  }

  // active: required, boolean
  if (payload.active === undefined || payload.active === null) {
    addError(errors, "active", "required", "active es requerido");
  } else if (typeof payload.active !== "boolean") {
    addError(errors, "active", "invalid_type", "active debe ser un booleano");
  }

  // target: required, enum
  if (!payload.target || (typeof payload.target === "string" && payload.target.trim() === "")) {
    addError(errors, "target", "required", "target es requerido");
  } else if (!(TARGET_OPTIONS as readonly string[]).includes(payload.target)) {
    addError(errors, "target", "invalid_enum", `target debe ser uno de: ${TARGET_OPTIONS.join(", ")}`);
  }

  // Ratio type: numeratorMetricKey and denominatorMetricKey required and must reference existing keys
  if (payload.type === "ratio") {
    if (!payload.numeratorMetricKey || payload.numeratorMetricKey.trim() === "") {
      addError(errors, "numeratorMetricKey", "required", "numeratorMetricKey es requerido para métricas de tipo ratio");
    } else if (!existingKeys.includes(payload.numeratorMetricKey)) {
      addError(errors, "numeratorMetricKey", "invalid_reference", "numeratorMetricKey no referencia una métrica existente");
    }

    if (!payload.denominatorMetricKey || payload.denominatorMetricKey.trim() === "") {
      addError(errors, "denominatorMetricKey", "required", "denominatorMetricKey es requerido para métricas de tipo ratio");
    } else if (!existingKeys.includes(payload.denominatorMetricKey)) {
      addError(errors, "denominatorMetricKey", "invalid_reference", "denominatorMetricKey no referencia una métrica existente");
    }
  }

  return toResult(errors);
}

// ─── validateCard ────────────────────────────────────────────────────────────

/**
 * Validates a card definition payload.
 * @param payload - The card payload to validate
 * @param existingCardKeys - Array of existing cardKey values (for uniqueness check)
 * @param existingMetricKeys - Array of existing metricKey values (for reference check)
 */
export function validateCard(
  payload: CreateCardPayload,
  existingCardKeys: string[],
  existingMetricKeys: string[]
): ValidationResult {
  const errors: ValidationError[] = [];

  // Reject readonly items
  if (payload.readonly === true) {
    addError(errors, "readonly", "readonly_item", "No se puede modificar un item de solo lectura");
    return toResult(errors);
  }

  // cardKey: required, max 64, unique
  if (!payload.cardKey || payload.cardKey.trim() === "") {
    addError(errors, "cardKey", "required", "cardKey es requerido");
  } else {
    if (payload.cardKey.length > MAX_KEY_LENGTH) {
      addError(errors, "cardKey", "max_length", `cardKey no debe exceder ${MAX_KEY_LENGTH} caracteres`);
    }
    if (existingCardKeys.includes(payload.cardKey)) {
      addError(errors, "cardKey", "duplicate", "cardKey ya existe");
    }
  }

  // metricKey: required, must reference existing metric
  if (!payload.metricKey || payload.metricKey.trim() === "") {
    addError(errors, "metricKey", "required", "metricKey es requerido");
  } else if (!existingMetricKeys.includes(payload.metricKey)) {
    addError(errors, "metricKey", "invalid_reference", "metricKey no referencia una métrica existente");
  }

  // title: required, max 120
  if (!payload.title || payload.title.trim() === "") {
    addError(errors, "title", "required", "title es requerido");
  } else if (payload.title.length > MAX_LABEL_LENGTH) {
    addError(errors, "title", "max_length", `title no debe exceder ${MAX_LABEL_LENGTH} caracteres`);
  }

  // icon: required
  if (!payload.icon || payload.icon.trim() === "") {
    addError(errors, "icon", "required", "icon es requerido");
  }

  // accentClass: required
  if (!payload.accentClass || payload.accentClass.trim() === "") {
    addError(errors, "accentClass", "required", "accentClass es requerido");
  }

  // order: required, integer between 1 and 999
  if (payload.order === undefined || payload.order === null) {
    addError(errors, "order", "required", "order es requerido");
  } else if (!Number.isInteger(payload.order) || payload.order < 1 || payload.order > 999) {
    addError(errors, "order", "invalid_range", "order debe ser un entero entre 1 y 999");
  }

  // visible: required, boolean
  if (payload.visible === undefined || payload.visible === null) {
    addError(errors, "visible", "required", "visible es requerido");
  } else if (typeof payload.visible !== "boolean") {
    addError(errors, "visible", "invalid_type", "visible debe ser un booleano");
  }

  // active: required, boolean
  if (payload.active === undefined || payload.active === null) {
    addError(errors, "active", "required", "active es requerido");
  } else if (typeof payload.active !== "boolean") {
    addError(errors, "active", "invalid_type", "active debe ser un booleano");
  }

  // target: required, enum
  if (!payload.target || (typeof payload.target === "string" && payload.target.trim() === "")) {
    addError(errors, "target", "required", "target es requerido");
  } else if (!(TARGET_OPTIONS as readonly string[]).includes(payload.target)) {
    addError(errors, "target", "invalid_enum", `target debe ser uno de: ${TARGET_OPTIONS.join(", ")}`);
  }

  return toResult(errors);
}

// ─── validateChart ───────────────────────────────────────────────────────────

/**
 * Validates a chart definition payload.
 * @param payload - The chart payload to validate
 * @param existingChartKeys - Array of existing chartKey values (for uniqueness check)
 * @param existingMetricKeys - Array of existing metricKey values (for reference check)
 */
export function validateChart(
  payload: CreateChartPayload,
  existingChartKeys: string[],
  existingMetricKeys: string[]
): ValidationResult {
  const errors: ValidationError[] = [];

  // Reject readonly items
  if (payload.readonly === true) {
    addError(errors, "readonly", "readonly_item", "No se puede modificar un item de solo lectura");
    return toResult(errors);
  }

  // chartKey: required, max 64, unique
  if (!payload.chartKey || payload.chartKey.trim() === "") {
    addError(errors, "chartKey", "required", "chartKey es requerido");
  } else {
    if (payload.chartKey.length > MAX_KEY_LENGTH) {
      addError(errors, "chartKey", "max_length", `chartKey no debe exceder ${MAX_KEY_LENGTH} caracteres`);
    }
    if (existingChartKeys.includes(payload.chartKey)) {
      addError(errors, "chartKey", "duplicate", "chartKey ya existe");
    }
  }

  // title: required, max 120
  if (!payload.title || payload.title.trim() === "") {
    addError(errors, "title", "required", "title es requerido");
  } else if (payload.title.length > MAX_LABEL_LENGTH) {
    addError(errors, "title", "max_length", `title no debe exceder ${MAX_LABEL_LENGTH} caracteres`);
  }

  // chartType: required, enum
  if (!payload.chartType || payload.chartType.trim() === "") {
    addError(errors, "chartType", "required", "chartType es requerido");
  } else if (!(CHART_TYPES as readonly string[]).includes(payload.chartType)) {
    addError(errors, "chartType", "invalid_enum", `chartType debe ser uno de: ${CHART_TYPES.join(", ")}`);
  }

  // metricKeys: required, array of 1-10 items, each must reference existing metric
  if (!payload.metricKeys || !Array.isArray(payload.metricKeys)) {
    addError(errors, "metricKeys", "required", "metricKeys es requerido y debe ser un array");
  } else {
    if (payload.metricKeys.length < 1 || payload.metricKeys.length > 10) {
      addError(errors, "metricKeys", "invalid_length", "metricKeys debe contener entre 1 y 10 elementos");
    }
    const invalidKeys = payload.metricKeys.filter(
      (key) => !existingMetricKeys.includes(key)
    );
    if (invalidKeys.length > 0) {
      addError(
        errors,
        "metricKeys",
        "invalid_reference",
        `Las siguientes metricKeys no existen: ${invalidKeys.join(", ")}`
      );
    }
  }

  // groupBy: required, enum
  if (!payload.groupBy || payload.groupBy.trim() === "") {
    addError(errors, "groupBy", "required", "groupBy es requerido");
  } else if (!(GROUP_BY_OPTIONS as readonly string[]).includes(payload.groupBy)) {
    addError(errors, "groupBy", "invalid_enum", `groupBy debe ser uno de: ${GROUP_BY_OPTIONS.join(", ")}`);
  }

  // target: required, enum
  if (!payload.target || (typeof payload.target === "string" && payload.target.trim() === "")) {
    addError(errors, "target", "required", "target es requerido");
  } else if (!(TARGET_OPTIONS as readonly string[]).includes(payload.target)) {
    addError(errors, "target", "invalid_enum", `target debe ser uno de: ${TARGET_OPTIONS.join(", ")}`);
  }

  // permissionModule: required
  if (!payload.permissionModule || payload.permissionModule.trim() === "") {
    addError(errors, "permissionModule", "required", "permissionModule es requerido");
  }

  return toResult(errors);
}

// ─── canDeleteMetric ─────────────────────────────────────────────────────────

/**
 * Checks if a metric can be deleted by verifying no cards or charts reference it.
 * @param metricKey - The metric key to check
 * @param cards - All card definitions to check against
 * @param charts - All chart definitions to check against
 */
export function canDeleteMetric(
  metricKey: string,
  cards: CardDefinition[],
  charts: ChartDefinition[]
): DeletionCheck {
  const referencedBy: string[] = [];

  // Check cards referencing this metricKey
  for (const card of cards) {
    if (card.metricKey === metricKey) {
      referencedBy.push(card.cardKey);
    }
  }

  // Check charts referencing this metricKey in their metricKeys array
  for (const chart of charts) {
    if (chart.metricKeys && chart.metricKeys.includes(metricKey)) {
      referencedBy.push(chart.chartKey);
    }
  }

  if (referencedBy.length > 0) {
    return { canDelete: false, referencedBy };
  }

  return { canDelete: true };
}
