import type { ParameterSchema } from './toolSelfRepair.js';

/** Validate canonical arguments before execution, without inventing missing values. */
export function validateToolArguments(value: unknown, schema?: ParameterSchema): string[] {
  const errors: string[] = [];
  const visit = (item: unknown, node: ParameterSchema, at: string, depth: number): void => {
    if (depth > 32 || errors.length >= 12) return;
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const variants = node[keyword];
      if (Array.isArray(variants) && variants.length > 0) {
        const matches = variants.filter(variant => variant && typeof variant === 'object'
          && validateToolArguments(item, variant as ParameterSchema).length === 0).length;
        if (matches === 0 || (keyword === 'oneOf' && matches !== 1)) {
          errors.push(`${at} does not satisfy ${keyword}`);
          return;
        }
      }
    }
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    const hasType = (type: string): boolean => {
      switch (type) {
        case 'null': return item === null;
        case 'object': return item !== null && typeof item === 'object' && !Array.isArray(item);
        case 'array': return Array.isArray(item);
        case 'integer': return typeof item === 'number' && Number.isSafeInteger(item);
        case 'number': return typeof item === 'number' && Number.isFinite(item);
        case 'string': case 'boolean': return typeof item === type;
        default: return true; // Unknown dialect constraints remain the tool's responsibility.
      }
    };
    if (types.length && !types.some(hasType)) { errors.push(`${at} must be ${types.join(' or ')}`); return; }
    if (Array.isArray(node.enum) && !node.enum.some(entry => JSON.stringify(entry) === JSON.stringify(item))) {
      errors.push(`${at} must be one of ${JSON.stringify(node.enum)}`);
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      for (const required of node.required || []) {
        if (!Object.hasOwn(record, required) || record[required] === undefined) errors.push(`${at}.${required} is required`);
      }
      for (const [key, child] of Object.entries(node.properties || {})) {
        if (Object.hasOwn(record, key) && record[key] !== undefined) visit(record[key], child, `${at}.${key}`, depth + 1);
      }
    }
    if (Array.isArray(item) && node.items && !Array.isArray(node.items)) {
      item.forEach((entry, index) => visit(entry, node.items!, `${at}[${index}]`, depth + 1));
    }
  };
  if (schema) visit(value, schema, 'arguments', 0);
  return errors;
}
