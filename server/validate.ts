/**
 * Tiny schema library (no dependencies). One schema definition serves two purposes:
 *  1. strict server-side validation of every API body and every model-supplied tool input
 *  2. generating the JSON Schema sent to the language-model provider
 */

export interface Issue {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; "));
    this.issues = issues;
  }
}

export interface Schema<T = any> {
  parseInto(value: unknown, path: string, issues: Issue[]): T | undefined;
  json(): Record<string, unknown>;
  isOptional: boolean;
  desc(text: string): Schema<T>;
  optional(): Schema<T | undefined>;
  parse(value: unknown): T;
}

function make<T>(
  core: (value: unknown, path: string, issues: Issue[]) => T | undefined,
  jsonSchema: Record<string, unknown>,
  opts: { optional?: boolean; description?: string } = {},
): Schema<T> {
  const schema: Schema<T> = {
    isOptional: !!opts.optional,
    parseInto(value, path, issues) {
      if (value === undefined) {
        if (!schema.isOptional) issues.push({ path, message: "is required" });
        return undefined;
      }
      return core(value, path, issues);
    },
    json() {
      return opts.description ? { ...jsonSchema, description: opts.description } : jsonSchema;
    },
    desc(text) {
      return make(core, jsonSchema, { ...opts, description: text });
    },
    optional() {
      return make(core, jsonSchema, { ...opts, optional: true }) as Schema<any>;
    },
    parse(value) {
      const issues: Issue[] = [];
      const out = schema.parseInto(value, "", issues);
      if (issues.length) throw new ValidationError(issues);
      return out as T;
    },
  };
  return schema;
}

export const v = {
  string(o: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Schema<string> {
    const min = o.min ?? 0;
    const max = o.max ?? 2000;
    return make<string>(
      (value, path, issues) => {
        if (typeof value !== "string") {
          issues.push({ path, message: "must be a string" });
          return undefined;
        }
        const s = o.trim === false ? value : value.trim();
        if (s.length < min) issues.push({ path, message: min === 1 ? "must not be empty" : `must be at least ${min} characters` });
        else if (s.length > max) issues.push({ path, message: `must be at most ${max} characters` });
        else if (o.pattern && !o.pattern.test(s)) issues.push({ path, message: `has an invalid format` });
        else return s;
        return undefined;
      },
      { type: "string", ...(min ? { minLength: min } : {}), maxLength: max },
    );
  },

  enum<const A extends readonly string[]>(values: A): Schema<A[number]> {
    return make<A[number]>(
      (value, path, issues) => {
        if (typeof value !== "string" || !values.includes(value)) {
          issues.push({ path, message: `must be one of: ${values.join(", ")}` });
          return undefined;
        }
        return value;
      },
      { type: "string", enum: [...values] },
    );
  },

  number(o: { min?: number; max?: number; int?: boolean } = {}): Schema<number> {
    return make<number>(
      (value, path, issues) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          issues.push({ path, message: "must be a number" });
          return undefined;
        }
        if (o.int && !Number.isInteger(value)) issues.push({ path, message: "must be an integer" });
        else if (o.min !== undefined && value < o.min) issues.push({ path, message: `must be >= ${o.min}` });
        else if (o.max !== undefined && value > o.max) issues.push({ path, message: `must be <= ${o.max}` });
        else return value;
        return undefined;
      },
      {
        type: o.int ? "integer" : "number",
        ...(o.min !== undefined ? { minimum: o.min } : {}),
        ...(o.max !== undefined ? { maximum: o.max } : {}),
      },
    );
  },

  boolean(): Schema<boolean> {
    return make<boolean>(
      (value, path, issues) => {
        if (typeof value !== "boolean") {
          issues.push({ path, message: "must be true or false" });
          return undefined;
        }
        return value;
      },
      { type: "boolean" },
    );
  },

  /** ISO 8601 date or date-time. Date-only values are normalised to 12:00 UTC. Output is always a full ISO string. */
  datetime(): Schema<string> {
    return make<string>(
      (value, path, issues) => {
        if (typeof value !== "string") {
          issues.push({ path, message: "must be an ISO 8601 date or date-time string" });
          return undefined;
        }
        const s = value.trim();
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
        const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s);
        if (!dateOnly && !full) {
          issues.push({ path, message: "must be ISO 8601, e.g. 2026-10-21 or 2026-10-21T18:00:00Z (a timezone offset is required for date-times)" });
          return undefined;
        }
        const d = new Date(dateOnly ? `${s}T12:00:00.000Z` : s);
        if (Number.isNaN(d.getTime())) {
          issues.push({ path, message: "is not a real calendar date" });
          return undefined;
        }
        const year = d.getUTCFullYear();
        if (year < 2000 || year > 2100) {
          issues.push({ path, message: "must be between years 2000 and 2100" });
          return undefined;
        }
        return d.toISOString();
      },
      { type: "string", description: "ISO 8601 date or date-time (include a timezone offset such as Z)" },
    );
  },

  /** Accepts null explicitly (used to clear a nullable field). */
  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return make<T | null>(
      (value, path, issues) => (value === null ? null : (inner.parseInto(value, path, issues) as T | undefined)),
      { anyOf: [inner.json(), { type: "null" }] },
    );
  },

  array<T>(item: Schema<T>, o: { max?: number } = {}): Schema<T[]> {
    const max = o.max ?? 50;
    return make<T[]>(
      (value, path, issues) => {
        if (!Array.isArray(value)) {
          issues.push({ path, message: "must be an array" });
          return undefined;
        }
        if (value.length > max) {
          issues.push({ path, message: `must have at most ${max} items` });
          return undefined;
        }
        const out: T[] = [];
        value.forEach((el, i) => {
          const r = item.parseInto(el, `${path}[${i}]`, issues);
          if (r !== undefined) out.push(r);
        });
        return out;
      },
      { type: "array", items: item.json(), maxItems: max },
    );
  },

  object<S extends Record<string, Schema<any>>>(shape: S): Schema<{ [K in keyof S]: ReturnType<S[K]["parse"]> }> {
    const keys = Object.keys(shape);
    return make<any>(
      (value, path, issues) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          issues.push({ path, message: "must be an object" });
          return undefined;
        }
        const input = value as Record<string, unknown>;
        for (const k of Object.keys(input)) {
          if (!keys.includes(k)) issues.push({ path: path ? `${path}.${k}` : k, message: "is not an allowed field" });
        }
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          const r = shape[k].parseInto(input[k], path ? `${path}.${k}` : k, issues);
          if (r !== undefined) out[k] = r;
        }
        return out;
      },
      {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, shape[k].json()])),
        required: keys.filter((k) => !shape[k].isOptional),
        additionalProperties: false,
      },
    );
  },
};
