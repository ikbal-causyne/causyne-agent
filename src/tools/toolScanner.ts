/**
 * Causyne Agent — Universal Tool Scanner & Compatibility Layer (toolsScan)
 *
 * Scans tool definitions for cross-vendor compatibility issues across LLM
 * providers (Gemini, Anthropic, OpenAI, DeepSeek, Ollama, Qwen, DashScope,
 * Moonshot, xAI, Muse, OpenRouter, Antigravity, ACP, Pi) and compiles them
 * deterministically into every provider's wire format without degrading or
 * altering the tool's underlying functionality.
 */

import { createHash } from 'node:crypto';

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface ToolScanIssue {
  tool: string;
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ToolScanReport {
  provider: string;
  totalTools: number;
  compatibleTools: number;
  incompatibleCount: number;
  issues: ToolScanIssue[];
  residualIssues: ToolScanIssue[];
  residualIncompatibleCount: number;
  repairedTools: string[];
  repairedCount: number;
  universalReady: boolean;
  adaptedTools: unknown[];
  freeFormPaths: Map<string, string[][]>;
}

export interface CrossProviderScanReport {
  totalTools: number;
  providersScanned: number;
  allUniversalReady: boolean;
  reports: Record<string, ToolScanReport>;
}

export type SchemaDialect = 'gemini' | 'strict_json';

export const ALL_PROVIDER_DIALECTS: readonly string[] = [
  'openai',
  'openai-compatible',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
  'dashscope',
  'moonshot',
  'xai',
  'muse',
  'openrouter',
  'ollama',
  'antigravity',
  'acp',
  'pi'
];

const FREE_FORM_NOTE = ' Pass this as a JSON object encoded in a string, for example {"key":"value"}.';
const POLYMORPHIC_ARRAY_NOTE = ' For multiple items, pass a JSON array encoded as a string, e.g. ["a","b"].';
const POLYMORPHIC_VALUE_NOTE = ' Pass non-string values (number, boolean, object, or array) encoded as JSON.';
const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const META_AND_COMBINATOR_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  '$ref',
  '$comment',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'examples'
]);

const GEMINI_STRING_FORMATS = new Set(['enum', 'date-time']);
const GEMINI_NUMBER_FORMATS = new Set(['float', 'double', 'int32', 'int64']);

function isGeminiFormatAllowed(typeVal: unknown, formatVal: unknown): boolean {
  if (typeof formatVal !== 'string' || !formatVal) return true;
  if (typeVal === 'string') return GEMINI_STRING_FORMATS.has(formatVal);
  if (typeVal === 'number' || typeVal === 'integer') return GEMINI_NUMBER_FORMATS.has(formatVal);
  return false;
}

const GEMINI_FORBIDDEN_KEYS = new Set([
  ...META_AND_COMBINATOR_KEYS,
  'additionalProperties',
  'default',
  'const',
  'nullable',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'contentEncoding',
  'contentMediaType',
  'readOnly',
  'writeOnly',
  'deprecated',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'uniqueItems'
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Standardize tool name to match the universal wire grammar ^[a-zA-Z0-9_-]{1,64}$.
 */
export function normalizeToolName(name: string): string {
  const sanitized = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!sanitized) return 'tool';
  if (sanitized.length <= 64) return sanitized;
  const suffix = createHash('sha256').update(sanitized).digest('hex').slice(0, 6);
  return `${sanitized.slice(0, 57)}_${suffix}`;
}

/**
 * Check if a schema node represents an empty object with no properties declared.
 */
export function isEmptyObjectSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  return schema['type'] === 'object' && (!isPlainObject(schema['properties']) || Object.keys(schema['properties']).length === 0);
}

function appendDescriptionNote(base: unknown, note: string): string {
  const text = typeof base === 'string' ? base.trim() : '';
  if (!text) return note.trim();
  if (text.includes(note.trim())) return text;
  return `${text}${note.startsWith(' ') ? '' : ' '}${note}`;
}

function inferPrimitiveTypeFromEnum(values: unknown[]): string {
  if (values.length === 0) return 'string';
  const types = new Set(values.map((v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    if (typeof v === 'boolean') return 'boolean';
    return 'string';
  }));
  if (types.size === 1) {
    return Array.from(types)[0] || 'string';
  }
  return 'string';
}

function resolveLocalRef(
  ref: string,
  defs: Record<string, unknown>,
  activeRefs: Set<string>
): Record<string, unknown> | null {
  if (!ref || activeRefs.has(ref)) return null;
  let key: string | null = null;
  if (ref.startsWith('#/$defs/')) {
    key = ref.slice('#/$defs/'.length);
  } else if (ref.startsWith('#/definitions/')) {
    key = ref.slice('#/definitions/'.length);
  }
  if (!key || !Object.hasOwn(defs, key)) return null;
  const target = defs[key];
  return isPlainObject(target) ? target : null;
}

function pushRewrittenPath(rewritten: string[][], path: string[]): void {
  if (path.length === 0) return;
  const key = path.join('\0');
  if (!rewritten.some((existing) => existing.join('\0') === key)) {
    rewritten.push([...path]);
  }
}

/**
 * Recursively inspect a schema for raw or residual provider incompatibilities.
 */
function inspectSchemaForProvider(
  toolName: string,
  schema: unknown,
  path: string[],
  provider: string,
  issues: ToolScanIssue[]
): void {
  if (path.length > 32 || !isPlainObject(schema)) return;
  const pathStr = path.join('.');
  const isGemini = provider === 'gemini';

  if (schema['type'] === 'array' && !schema['items']) {
    issues.push({
      tool: toolName,
      path: pathStr,
      code: 'ARRAY_MISSING_ITEMS',
      message: `Array schema at '${pathStr}' lacks 'items' definition.`,
      severity: 'error'
    });
  }

  if (Array.isArray(schema['type'])) {
    issues.push({
      tool: toolName,
      path: pathStr,
      code: 'UNION_TYPE_ARRAY',
      message: `Union type array [${(schema['type'] as string[]).join(', ')}] at '${pathStr}' is unsupported by OpenAPI 3.0 / Gemini / DeepSeek.`,
      severity: 'warning'
    });
  }

  if (Array.isArray(schema['oneOf']) || Array.isArray(schema['anyOf']) || Array.isArray(schema['allOf']) || 'not' in schema) {
    issues.push({
      tool: toolName,
      path: pathStr,
      code: 'UNSUPPORTED_COMBINATOR',
      message: `Schema combinator (oneOf/anyOf/allOf/not) at '${pathStr}' must be compiled for universal provider compatibility.`,
      severity: isGemini ? 'error' : 'warning'
    });
  }

  const hasCombinator = Boolean(schema['oneOf'] || schema['anyOf'] || schema['allOf']);
  const isRootSchema = path.length === 1 && path[0] === 'parameters';
  if (!isRootSchema && !schema['type'] && !isPlainObject(schema['properties']) && !schema['items'] && !hasCombinator && !('$ref' in schema)) {
    issues.push({
      tool: toolName,
      path: pathStr,
      code: 'MISSING_TYPE',
      message: `Schema at '${pathStr}' declares no 'type', properties, or combinator.`,
      severity: isGemini ? 'error' : 'warning'
    });
  }

  if (schema['type'] === 'object' && Array.isArray(schema['required']) && isPlainObject(schema['properties'])) {
    const props = schema['properties'];
    for (const req of schema['required']) {
      if (typeof req === 'string' && !Object.hasOwn(props, req)) {
        issues.push({
          tool: toolName,
          path: `${pathStr}.required.${req}`,
          code: 'REQUIRED_PROPERTY_MISSING',
          message: `'required' entry "${req}" at '${pathStr}' is absent from 'properties'.`,
          severity: 'warning'
        });
      }
    }
  }

  if (isGemini) {
    if ('additionalProperties' in schema) {
      issues.push({
        tool: toolName,
        path: pathStr,
        code: 'GEMINI_ADDITIONAL_PROPERTIES',
        message: `'additionalProperties' at '${pathStr}' is forbidden in Gemini OpenAPI 3.0 subset.`,
        severity: 'error'
      });
    }

    if (schema['type'] === 'object' && (!isPlainObject(schema['properties']) || Object.keys(schema['properties']).length === 0)) {
      issues.push({
        tool: toolName,
        path: pathStr,
        code: 'GEMINI_EMPTY_OBJECT_SCHEMA',
        message: `Empty object schema at '${pathStr}' without declared properties is rejected by Gemini.`,
        severity: 'error'
      });
    }

    if (Array.isArray(schema['enum']) && (schema['type'] !== 'string' || schema['enum'].some((v) => typeof v !== 'string'))) {
      issues.push({
        tool: toolName,
        path: pathStr,
        code: 'GEMINI_NON_STRING_ENUM',
        message: `Non-string enum at '${pathStr}' is rejected by Gemini OpenAPI Schema.`,
        severity: 'warning'
      });
    }

    if (typeof schema['format'] === 'string' && !isGeminiFormatAllowed(schema['type'], schema['format'])) {
      issues.push({
        tool: toolName,
        path: pathStr,
        code: 'GEMINI_UNSUPPORTED_FORMAT',
        message: `Unsupported format '${schema['format']}' on type '${String(schema['type'] || 'unknown')}' at '${pathStr}' in Gemini OpenAPI Schema.`,
        severity: 'error'
      });
    }

    for (const key of Object.keys(schema)) {
      if (key !== 'additionalProperties' && GEMINI_FORBIDDEN_KEYS.has(key)) {
        issues.push({
          tool: toolName,
          path: pathStr,
          code: 'GEMINI_UNSUPPORTED_KEYWORDS',
          message: `Unsupported JSON Schema keyword '${key}' at '${pathStr}' in Gemini.`,
          severity: key === 'default' || key === '$schema' ? 'error' : 'warning'
        });
        break;
      }
    }
  }

  if (isPlainObject(schema['properties'])) {
    for (const [propKey, propVal] of Object.entries(schema['properties'])) {
      inspectSchemaForProvider(toolName, propVal, [...path, propKey], provider, issues);
    }
  }

  if (isPlainObject(schema['items'])) {
    inspectSchemaForProvider(toolName, schema['items'], [...path, '[]'], provider, issues);
  }

  for (const comb of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = schema[comb];
    if (Array.isArray(arr)) {
      arr.forEach((branch, idx) => {
        inspectSchemaForProvider(toolName, branch, [...path, `${comb}[${idx}]`], provider, issues);
      });
    }
  }
}

function mergeAllOfBranches(
  branches: unknown[],
  dialect: SchemaDialect,
  path: string[],
  rewritten: string[][],
  defs: Record<string, unknown>,
  activeRefs: Set<string>,
  parent: Record<string, unknown>
): Record<string, unknown> {
  const mergedProps: Record<string, unknown> = isPlainObject(parent['properties'])
    ? { ...parent['properties'] }
    : {};
  const mergedRequired = new Set<string>(
    Array.isArray(parent['required']) ? parent['required'].filter((x): x is string => typeof x === 'string') : []
  );
  const descriptions: string[] = typeof parent['description'] === 'string' && parent['description'].trim()
    ? [parent['description'].trim()]
    : [];
  let resolvedType: unknown = parent['type'];

  for (const branch of branches) {
    const adaptedBranch = compileSchemaNode(branch, dialect, path, rewritten, defs, activeRefs);
    if (!isPlainObject(adaptedBranch)) continue;
    if (typeof adaptedBranch['description'] === 'string' && adaptedBranch['description'].trim() && !descriptions.includes(adaptedBranch['description'].trim())) {
      descriptions.push(adaptedBranch['description'].trim());
    }
    if (!resolvedType && adaptedBranch['type']) resolvedType = adaptedBranch['type'];
    if (isPlainObject(adaptedBranch['properties'])) {
      Object.assign(mergedProps, adaptedBranch['properties']);
    }
    if (Array.isArray(adaptedBranch['required'])) {
      for (const req of adaptedBranch['required']) {
        if (typeof req === 'string') mergedRequired.add(req);
      }
    }
  }

  const result: Record<string, unknown> = {};
  if (descriptions.length > 0) result['description'] = descriptions.join(' ');
  const propKeys = Object.keys(mergedProps);
  if (resolvedType === 'object' || propKeys.length > 0) {
    result['type'] = 'object';
    result['properties'] = mergedProps;
    const validReq = Array.from(mergedRequired).filter((k) => k in mergedProps);
    if (validReq.length > 0) result['required'] = validReq;
  } else if (typeof resolvedType === 'string') {
    result['type'] = resolvedType;
  } else {
    result['type'] = 'string';
    result['description'] = appendDescriptionNote(result['description'], POLYMORPHIC_VALUE_NOTE);
    pushRewrittenPath(rewritten, path);
  }
  return result;
}

function collapseUnionVariants(
  variants: unknown[],
  dialect: SchemaDialect,
  path: string[],
  rewritten: string[][],
  defs: Record<string, unknown>,
  activeRefs: Set<string>,
  parent: Record<string, unknown>
): Record<string, unknown> {
  const nonNull = variants.filter((entry) => !(isPlainObject(entry) && entry['type'] === 'null'));
  const isNullable = nonNull.length < variants.length;
  const baseDesc = typeof parent['description'] === 'string' ? parent['description'] : undefined;

  if (nonNull.length === 0) {
    pushRewrittenPath(rewritten, path);
    return {
      type: 'string',
      description: appendDescriptionNote(baseDesc, POLYMORPHIC_VALUE_NOTE)
    };
  }

  if (nonNull.length === 1) {
    const single = isPlainObject(nonNull[0]) ? { ...nonNull[0] } : {};
    if (baseDesc && !single['description']) single['description'] = baseDesc;
    if (isNullable && typeof single['description'] === 'string') {
      single['description'] = appendDescriptionNote(single['description'], ' (optional/nullable)');
    }
    return compileSchemaNode(single, dialect, path, rewritten, defs, activeRefs) as Record<string, unknown>;
  }

  const compiledBranches = nonNull.map((branch) =>
    compileSchemaNode(branch, dialect, path, rewritten, defs, activeRefs)
  ).filter(isPlainObject);

  const branchTypes = Array.from(new Set(
    compiledBranches.map((b) => typeof b['type'] === 'string' ? b['type'] : 'string')
  ));

  if (branchTypes.length === 1 && branchTypes[0] === 'object') {
    const mergedProps: Record<string, unknown> = {};
    let commonRequired: Set<string> | null = null;
    for (const branch of compiledBranches) {
      if (isPlainObject(branch['properties'])) {
        Object.assign(mergedProps, branch['properties']);
      }
      const reqs = new Set<string>(
        Array.isArray(branch['required']) ? branch['required'].filter((x): x is string => typeof x === 'string') : []
      );
      if (commonRequired === null) {
        commonRequired = reqs;
      } else {
        const intersected = new Set<string>();
        for (const k of commonRequired) {
          if (reqs.has(k)) intersected.add(k);
        }
        commonRequired = intersected;
      }
    }
    const validReq = commonRequired ? Array.from(commonRequired).filter((k) => k in mergedProps) : [];
    const result: Record<string, unknown> = {
      type: 'object',
      properties: mergedProps
    };
    if (baseDesc) result['description'] = baseDesc;
    if (validReq.length > 0) result['required'] = validReq;
    return isEmptyObjectSchema(result) && dialect === 'gemini'
      ? (() => {
          pushRewrittenPath(rewritten, path);
          return { type: 'string', description: appendDescriptionNote(baseDesc, FREE_FORM_NOTE) };
        })()
      : result;
  }

  if (branchTypes.length === 1 && (branchTypes[0] === 'string' || branchTypes[0] === 'number' || branchTypes[0] === 'integer' || branchTypes[0] === 'boolean')) {
    const singleType = branchTypes[0];
    const result: Record<string, unknown> = { type: singleType };
    const enumSet = new Set<string>();
    let allHaveStringEnums = true;
    for (const branch of compiledBranches) {
      if (Array.isArray(branch['enum']) && branch['enum'].every((v) => typeof v === 'string')) {
        for (const v of branch['enum']) enumSet.add(v as string);
      } else {
        allHaveStringEnums = false;
      }
    }
    if (baseDesc) result['description'] = baseDesc;
    if (allHaveStringEnums && enumSet.size > 0 && singleType === 'string') {
      result['enum'] = Array.from(enumSet);
    }
    return result;
  }

  // Incompatible multi-type union (e.g. oneOf: [string, array<string>]) -> universal string with JSON decoding
  pushRewrittenPath(rewritten, path);
  const includesArray = branchTypes.includes('array');
  const note = includesArray ? POLYMORPHIC_ARRAY_NOTE : POLYMORPHIC_VALUE_NOTE;
  return {
    type: 'string',
    description: appendDescriptionNote(baseDesc, note)
  };
}

function compileSchemaNode(
  schema: unknown,
  dialect: SchemaDialect,
  path: string[],
  rewritten: string[][],
  defs: Record<string, unknown>,
  activeRefs: Set<string>
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => compileSchemaNode(entry, dialect, path, rewritten, defs, activeRefs));
  }
  if (!isPlainObject(schema)) {
    return schema;
  }

  const localDefs = {
    ...defs,
    ...(isPlainObject(schema['$defs']) ? schema['$defs'] : {}),
    ...(isPlainObject(schema['definitions']) ? schema['definitions'] : {})
  };

  if (typeof schema['$ref'] === 'string') {
    const refTarget = resolveLocalRef(schema['$ref'], localDefs, activeRefs);
    if (!refTarget) {
      pushRewrittenPath(rewritten, path);
      return {
        type: 'string',
        description: appendDescriptionNote(schema['description'], FREE_FORM_NOTE)
      };
    }
    const nextActive = new Set(activeRefs);
    nextActive.add(schema['$ref']);
    const mergedRef: Record<string, unknown> = {
      ...refTarget,
      ...(typeof schema['description'] === 'string' ? { description: schema['description'] } : {})
    };
    return compileSchemaNode(mergedRef, dialect, path, rewritten, localDefs, nextActive);
  }

  if (Array.isArray(schema['allOf']) && schema['allOf'].length > 0) {
    return mergeAllOfBranches(schema['allOf'], dialect, path, rewritten, localDefs, activeRefs, schema);
  }

  if (Array.isArray(schema['oneOf']) && schema['oneOf'].length > 0) {
    return collapseUnionVariants(schema['oneOf'], dialect, path, rewritten, localDefs, activeRefs, schema);
  }

  if (Array.isArray(schema['anyOf']) && schema['anyOf'].length > 0) {
    return collapseUnionVariants(schema['anyOf'], dialect, path, rewritten, localDefs, activeRefs, schema);
  }

  // Handle nested empty objects on Gemini anywhere in the tree (properties, items, combinators).
  // Skip flattening root schema itself (path.length === 0): root parameterless tools omit parameters on Gemini.
  if (dialect === 'gemini' && path.length > 0 && isEmptyObjectSchema(schema)) {
    pushRewrittenPath(rewritten, path);
    return {
      type: 'string',
      description: appendDescriptionNote(schema['description'] || 'Free-form object.', FREE_FORM_NOTE)
    };
  }

  const forbidden = dialect === 'gemini' ? GEMINI_FORBIDDEN_KEYS : META_AND_COMBINATOR_KEYS;
  const adapted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (forbidden.has(key)) continue;

    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === 'string');
      const nonNull = types.filter((t) => t !== 'null');
      const safeType = nonNull.includes('string') ? 'string' : (nonNull[0] || 'string');
      adapted['type'] = safeType;
      if (nonNull.length > 1) {
        pushRewrittenPath(rewritten, path);
      }
      if (schema['description'] || nonNull.length > 1) {
        const descBase = typeof adapted['description'] === 'string'
          ? adapted['description']
          : typeof schema['description'] === 'string'
            ? schema['description']
            : '';
        adapted['description'] = appendDescriptionNote(descBase, ` (accepts ${types.join(' or ')})`);
      }
      continue;
    }

    if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, child] of Object.entries(value)) {
        props[propName] = compileSchemaNode(child, dialect, [...path, propName], rewritten, localDefs, activeRefs);
      }
      adapted['properties'] = props;
      continue;
    }

    if (key === 'items') {
      adapted['items'] = compileSchemaNode(value, dialect, [...path, '[]'], rewritten, localDefs, activeRefs);
      continue;
    }

    if (key === 'enum' && Array.isArray(value)) {
      adapted['enum'] = value;
      continue;
    }

    adapted[key] = isPlainObject(value) || Array.isArray(value)
      ? compileSchemaNode(value, dialect, path, rewritten, localDefs, activeRefs)
      : value;
  }

  // Handle const values gracefully after stripping const on Gemini
  if ('const' in schema && !('enum' in adapted) && typeof schema['const'] === 'string') {
    if (!adapted['type']) adapted['type'] = 'string';
    adapted['enum'] = [schema['const']];
  } else if ('default' in schema && dialect === 'gemini' && typeof adapted['description'] === 'string') {
    const defText = `default: ${String(schema['default'])}`;
    if (!adapted['description'].toLowerCase().includes('default')) {
      adapted['description'] = appendDescriptionNote(adapted['description'], ` (${defText})`);
    }
  }

  // Repair typeless leaf schemas (e.g. dynamic MCP or legacy tools lacking 'type')
  if (!adapted['type']) {
    if (isPlainObject(adapted['properties'])) {
      adapted['type'] = 'object';
    } else if (adapted['items']) {
      adapted['type'] = 'array';
    } else if (Array.isArray(adapted['enum'])) {
      adapted['type'] = inferPrimitiveTypeFromEnum(adapted['enum']);
    } else {
      adapted['type'] = 'string';
      adapted['description'] = appendDescriptionNote(adapted['description'], POLYMORPHIC_VALUE_NOTE);
      pushRewrittenPath(rewritten, path);
    }
  }

  if (adapted['type'] === 'object' && !isPlainObject(adapted['properties'])) {
    adapted['properties'] = {};
  }

  if (adapted['type'] === 'array' && !adapted['items']) {
    adapted['items'] = { type: 'string' };
  }

  // Gemini OpenAPI Schema only accepts enum on string properties with string items
  if (dialect === 'gemini' && Array.isArray(adapted['enum'])) {
    const nonStringEnum = adapted['enum'].some((item) => typeof item !== 'string');
    if (adapted['type'] !== 'string' || nonStringEnum) {
      const allowed = adapted['enum'].map((v) => String(v)).join(', ');
      delete adapted['enum'];
      adapted['description'] = appendDescriptionNote(adapted['description'], ` Allowed values: ${allowed}.`);
    }
  }

  // Gemini OpenAPI 3.0 Schema only supports format: enum|date-time on strings and float|double|int32|int64 on numbers
  if (dialect === 'gemini' && typeof adapted['format'] === 'string' && !isGeminiFormatAllowed(adapted['type'], adapted['format'])) {
    const fmt = adapted['format'];
    delete adapted['format'];
    if (typeof adapted['description'] !== 'string' || !adapted['description'].toLowerCase().includes(fmt.toLowerCase())) {
      adapted['description'] = appendDescriptionNote(adapted['description'], ` (format: ${fmt})`);
    }
  }

  if (adapted['type'] === 'object' && Array.isArray(adapted['required']) && isPlainObject(adapted['properties'])) {
    const props = adapted['properties'];
    const filtered = adapted['required'].filter((k): k is string => typeof k === 'string' && Object.hasOwn(props, k));
    if (filtered.length > 0) {
      adapted['required'] = filtered;
    } else {
      delete adapted['required'];
    }
  }

  return adapted;
}

/**
 * Compile an arbitrary schema into a dialect-clean schema without changing behavior
 * when the schema is already clean.
 */
export function normalizeUniversalSchema(
  schema: unknown,
  path: string[] = [],
  rewritten: string[][] = [],
  dialect: SchemaDialect = 'strict_json'
): Record<string, unknown> | unknown[] | unknown {
  return compileSchemaNode(schema, dialect, path, rewritten, {}, new Set());
}

/**
 * Adapt a schema into Gemini's strict OpenAPI 3.0 subset without losing capability.
 * Free-form objects and incompatible unions are compiled to stringified JSON schemas and recorded.
 */
export function adaptSchemaForGemini(
  schema: unknown,
  path: string[] = [],
  rewritten: string[][] = []
): Record<string, unknown> | unknown[] | unknown {
  return compileSchemaNode(schema, 'gemini', path, rewritten, {}, new Set());
}

/**
 * Adapt a tool schema into Anthropic's Messages API format.
 */
export function adaptSchemaForAnthropic(
  toolObj: ToolDefinition,
  options: { deferLoading?: boolean; rewritten?: string[][] } = {}
): Record<string, unknown> {
  const rawParams = toolObj.parameters || toolObj.input_schema || {};
  let schema: Record<string, unknown> = isPlainObject(rawParams) ? { ...rawParams } : { type: 'object', properties: {} };

  if (schema['type'] !== 'object' && !isPlainObject(schema['properties']) && !schema['allOf']) {
    schema = { type: 'object', properties: {} };
  } else if (!schema['type']) {
    schema['type'] = 'object';
  }
  if (!isPlainObject(schema['properties']) && !schema['allOf']) {
    schema['properties'] = {};
  }

  const rewritten = options.rewritten ?? [];
  const cleanSchema = compileSchemaNode(schema, 'strict_json', [], rewritten, {}, new Set()) as Record<string, unknown>;
  const name = normalizeToolName(toolObj.name);

  const declaration: Record<string, unknown> = {
    name,
    description: toolObj.description || `Tool ${name}`,
    input_schema: cleanSchema
  };

  if (options.deferLoading) {
    declaration['defer_loading'] = true;
  }

  return declaration;
}

/**
 * Adapt a tool schema into OpenAI / OpenAI-Compatible (DeepSeek, xAI, Moonshot, Qwen, Muse, OpenRouter) format.
 */
export function adaptSchemaForOpenAI(
  toolObj: ToolDefinition,
  options: { rewritten?: string[][] } = {}
): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  const rawParams = toolObj.parameters || toolObj.input_schema || {};
  let parameters: Record<string, unknown> = isPlainObject(rawParams) ? { ...rawParams } : { type: 'object', properties: {} };

  if (parameters['type'] !== 'object' && !isPlainObject(parameters['properties']) && !parameters['allOf']) {
    parameters = { type: 'object', properties: {} };
  } else if (!parameters['type']) {
    parameters['type'] = 'object';
  }
  if (!isPlainObject(parameters['properties']) && !parameters['allOf']) {
    parameters['properties'] = {};
  }

  const rewritten = options.rewritten ?? [];
  const cleanParams = compileSchemaNode(parameters, 'strict_json', [], rewritten, {}, new Set()) as Record<string, unknown>;
  const name = normalizeToolName(toolObj.name);

  return {
    type: 'function',
    function: {
      name,
      description: toolObj.description || `Tool ${name}`,
      parameters: cleanParams
    }
  };
}

/**
 * Adapt a tool schema into Ollama format (clean, straightforward parameters).
 */
export function adaptSchemaForOllama(
  toolObj: ToolDefinition,
  options: { rewritten?: string[][] } = {}
): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  return adaptSchemaForOpenAI(toolObj, options);
}

function extractAdaptedParameters(adapted: unknown, provider: string): unknown {
  if (!isPlainObject(adapted)) return undefined;
  const p = provider.toLowerCase();
  if (p === 'anthropic') return adapted['input_schema'];
  if (p === 'gemini') return adapted['parameters'];
  if (p === 'antigravity' || p === 'agy') return adapted['parameters'];
  if (p.startsWith('acp') || p === 'pi') return adapted['inputSchema'];
  if (isPlainObject(adapted['function'])) return adapted['function']['parameters'];
  return adapted['parameters'];
}

/**
 * Scans a set of tool definitions for compatibility with a specific provider,
 * adapts every tool cleanly to the provider's dialect without degrading capability,
 * and re-verifies that 0 residual dialect violations survive compilation.
 */
export function scanAndAdaptToolsForProvider(
  tools: ToolDefinition[],
  provider: string,
  options: {
    coreToolCount?: number;
    useToolSearch?: boolean;
  } = {}
): ToolScanReport {
  const normProvider = provider.toLowerCase();
  const issues: ToolScanIssue[] = [];
  const residualIssues: ToolScanIssue[] = [];
  const adaptedTools: unknown[] = [];
  const freeFormPaths = new Map<string, string[][]>();
  const repairedToolsSet = new Set<string>();

  const isGemini = normProvider === 'gemini';
  const isAnthropic = normProvider === 'anthropic';
  const isOllama = normProvider === 'ollama';
  const isAntigravity = normProvider === 'antigravity' || normProvider === 'agy';
  const isAcp = normProvider.startsWith('acp') || normProvider === 'pi';

  for (let index = 0; index < tools.length; index++) {
    const t = tools[index];
    if (!t) continue;
    const toolObj = (isPlainObject(t.function) ? t.function : t) as ToolDefinition;
    const name = normalizeToolName(toolObj.name);
    const description = toolObj.description || `Tool ${name}`;

    if (!TOOL_NAME_REGEX.test(name)) {
      issues.push({
        tool: name,
        path: 'name',
        code: 'INVALID_TOOL_NAME',
        message: `Tool name "${name}" violates grammar ^[a-zA-Z0-9_-]{1,64}$`,
        severity: 'error'
      });
    }

    if (!toolObj.description) {
      issues.push({
        tool: name,
        path: 'description',
        code: 'MISSING_TOOL_DESCRIPTION',
        message: `Tool "${name}" is missing a description.`,
        severity: 'warning'
      });
    }

    const rawSchema = toolObj.parameters || toolObj.input_schema;
    const rawIssueStart = issues.length;
    inspectSchemaForProvider(name, rawSchema, ['parameters'], normProvider, issues);
    if (issues.length > rawIssueStart) {
      repairedToolsSet.add(name);
    }

    const rewritten: string[][] = [];
    let adapted: unknown;

    if (isGemini) {
      const declaration: Record<string, unknown> = { name, description };
      if (rawSchema) {
        const compiled = adaptSchemaForGemini(rawSchema, [], rewritten);
        if (!isEmptyObjectSchema(compiled)) {
          declaration['parameters'] = compiled;
        }
      }
      adapted = declaration;
    } else if (isAnthropic) {
      const deferLoading = Boolean(
        options.useToolSearch &&
        typeof options.coreToolCount === 'number' &&
        index >= options.coreToolCount
      );
      adapted = adaptSchemaForAnthropic(toolObj, { deferLoading, rewritten });
    } else if (isOllama) {
      adapted = adaptSchemaForOllama(toolObj, { rewritten });
    } else if (isAntigravity) {
      const cleanParams = compileSchemaNode(rawSchema || { type: 'object', properties: {} }, 'strict_json', [], rewritten, {}, new Set()) as Record<string, unknown>;
      adapted = {
        name,
        description,
        parameters: cleanParams,
        snippet: `<tool_call>{"name": "${name}", "arguments": { ... }}</tool_call>`
      };
    } else if (isAcp) {
      const cleanParams = compileSchemaNode(rawSchema || { type: 'object', properties: {} }, 'strict_json', [], rewritten, {}, new Set()) as Record<string, unknown>;
      adapted = {
        name,
        description,
        inputSchema: cleanParams
      };
    } else {
      adapted = adaptSchemaForOpenAI(toolObj, { rewritten });
    }

    if (rewritten.length > 0) {
      freeFormPaths.set(name, rewritten);
      repairedToolsSet.add(name);
    }

    adaptedTools.push(adapted);

    // Post-adaptation verification (toolsScan closed-loop guarantee)
    if (!TOOL_NAME_REGEX.test(name)) {
      residualIssues.push({
        tool: name,
        path: 'name',
        code: 'RESIDUAL_INVALID_TOOL_NAME',
        message: `Adapted tool name "${name}" violates ^[a-zA-Z0-9_-]{1,64}$`,
        severity: 'error'
      });
    }
    const adaptedParams = extractAdaptedParameters(adapted, normProvider);
    if (adaptedParams) {
      inspectSchemaForProvider(name, adaptedParams, ['parameters'], normProvider, residualIssues);
    }
  }

  const incompatibleCount = issues.filter((i) => i.severity === 'error').length;
  const residualIncompatibleCount = residualIssues.filter((i) => i.severity === 'error').length;
  const repairedTools = Array.from(repairedToolsSet);

  return {
    provider: normProvider,
    totalTools: tools.length,
    compatibleTools: Math.max(0, tools.length - incompatibleCount),
    incompatibleCount,
    issues,
    residualIssues,
    residualIncompatibleCount,
    repairedTools,
    repairedCount: repairedTools.length,
    universalReady: residualIncompatibleCount === 0,
    adaptedTools,
    freeFormPaths
  };
}

/**
 * Audit a full tool catalogue across all supported LLM providers offline (`toolsScan`).
 */
export function scanAllProvidersCompatibility(
  tools: ToolDefinition[],
  providers: readonly string[] = ALL_PROVIDER_DIALECTS
): CrossProviderScanReport {
  const reports: Record<string, ToolScanReport> = {};
  let allUniversalReady = true;

  for (const provider of providers) {
    const report = scanAndAdaptToolsForProvider(tools, provider);
    reports[provider] = report;
    if (!report.universalReady || report.adaptedTools.length !== tools.length) {
      allUniversalReady = false;
    }
  }

  return {
    totalTools: tools.length,
    providersScanned: providers.length,
    allUniversalReady,
    reports
  };
}

/**
 * Decode adapted free-form / polymorphic JSON string arguments back into native values.
 * Only parses structured JSON containers ({...}, [...]) or quoted strings so plain filenames
 * or text strings such as "index.html" or "42" are preserved intact.
 */
export function decodeFreeFormArguments(
  args: Record<string, unknown>,
  paths: string[][]
): Record<string, unknown> {
  if (!args || !paths || paths.length === 0) return args;

  for (const argPath of paths) {
    applyAtPath(args, argPath, (value: unknown) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      const isStructuredJson =
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'));
      if (!isStructuredJson) return value;
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    });
  }

  return args;
}

function applyAtPath(
  node: unknown,
  path: string[],
  transform: (val: unknown) => unknown
): void {
  if (node === null || typeof node !== 'object') return;
  const target = node as Record<string, unknown>;

  const [head, ...rest] = path;
  if (!head || head === '__proto__' || head === 'constructor' || head === 'prototype') return;

  if (head === '[]') {
    if (!Array.isArray(node)) return;
    for (const entry of node) applyAtPath(entry, rest, transform);
    return;
  }

  if (!Object.hasOwn(target, head)) return;

  if (rest.length === 0) {
    target[head] = transform(target[head]);
    return;
  }

  applyAtPath(target[head], rest, transform);
}
