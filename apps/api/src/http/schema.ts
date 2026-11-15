/** The JSON Schema subset used by routes, the OpenAPI document and the generated SDK. */
export interface JsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null' |
    readonly ('object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null')[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly maxProperties?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly $ref?: string;
  readonly description?: string;
  readonly format?: string;
}

export type SchemaComponents = Readonly<Record<string, JsonSchema>>;

const typeOf = (value: unknown): string => value === null ? 'null'
  : Array.isArray(value) ? 'array'
    : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;

/** Returns the first violation as a JSON pointer-ish path, or null when valid. */
export function validateSchema(schema: JsonSchema, value: unknown,
  components: SchemaComponents, path = '$'): string | null {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = components[name];
    return target ? validateSchema(target, value, components, path) : path + ': unknown $ref';
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(option =>
      validateSchema(option, value, components, path) === null).length;
    return passing === 1 ? null : path + ': must match exactly one schema';
  }
  if (schema.const !== undefined && value !== schema.const) return path + ': unexpected value';
  if (schema.enum && !schema.enum.includes(value as string)) return path + ': not an allowed value';
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.includes(actual as never) && !(actual === 'integer' && allowed.includes('number')))
      return path + ': expected ' + allowed.join('|');
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return path + ': too short';
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return path + ': too long';
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
      return path + ': invalid format';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return path + ': not finite';
    if (schema.minimum !== undefined && value < schema.minimum) return path + ': too small';
    if (schema.maximum !== undefined && value > schema.maximum) return path + ': too large';
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return path + ': too few items';
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return path + ': too many items';
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        const error = validateSchema(schema.items, item, components, path + '[' + index + ']');
        if (error) return error;
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      return path + ': too many properties';
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(record, required)) return path + '.' + required + ': required';
    }
    for (const key of keys) {
      const property = schema.properties && Object.hasOwn(schema.properties, key)
        ? schema.properties[key] : undefined;
      if (property) {
        const error = validateSchema(property, record[key], components, path + '.' + key);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return path + '.' + key + ': unexpected property';
      } else if (typeof schema.additionalProperties === 'object') {
        const error = validateSchema(schema.additionalProperties, record[key], components,
          path + '.' + key);
        if (error) return error;
      }
    }
  }
  return null;
}

/** Small schema builders so route definitions stay readable. */
export const s = {
  ref: (name: string): JsonSchema => ({$ref: '#/components/schemas/' + name}),
  string: (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({type: 'string', ...options}),
  id: (): JsonSchema => ({type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'}),
  key: (): JsonSchema => ({type: 'string', pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$'}),
  integer: (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({type: 'integer', ...options}),
  number: (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({type: 'number', ...options}),
  boolean: (): JsonSchema => ({type: 'boolean'}),
  nullable: (schema: JsonSchema): JsonSchema => ({...schema,
    type: [schema.type as 'string', 'null']}),
  enum: (...values: string[]): JsonSchema => ({type: 'string', enum: values}),
  array: (items: JsonSchema, options: Omit<JsonSchema, 'type' | 'items'> = {}): JsonSchema =>
    ({type: 'array', items, ...options}),
  object: (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties),
    options: Omit<JsonSchema, 'type' | 'properties' | 'required'> = {}): JsonSchema =>
    ({type: 'object', additionalProperties: false, properties, required, ...options}),
  map: (values: JsonSchema, maxProperties = 64): JsonSchema =>
    ({type: 'object', additionalProperties: values, maxProperties}),
};
