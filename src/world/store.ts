import type { Domain } from "../spec/schema.ts";
import { matches, pruneUndefined, type Row } from "./match.ts";

export type Snapshot = Record<string, Row[]>;

export interface Change {
  table: string;
  key: string;
  kind: "insert" | "update" | "delete";
  before?: Row;
  after?: Row;
}

export class WorldError extends Error {}

interface Table {
  key: string;
  rows: Map<string, Row>;
  nextId: number;
}

/** In-memory, resettable copy of the customer's records. Every episode gets a fresh World. */
export class World {
  private readonly tables = new Map<string, Table>();

  constructor(spec: Domain["world"]) {
    for (const [name, table] of Object.entries(spec.tables)) {
      const rows = new Map<string, Row>();
      for (const row of table.rows) rows.set(String(row[table.key]), structuredClone(row));
      this.tables.set(name, { key: table.key, rows, nextId: rows.size + 1 });
    }
  }

  get(table: string, key: string): Row | undefined {
    const row = this.table(table).rows.get(key);
    return row ? structuredClone(row) : undefined;
  }

  list(table: string, where: Row = {}, limit?: number): Row[] {
    const filter = pruneUndefined(where);
    const rows = [...this.table(table).rows.values()].filter((row) => matches(row, filter));
    return structuredClone(limit ? rows.slice(0, limit) : rows);
  }

  insert(table: string, values: Row): Row {
    const t = this.table(table);
    const row = pruneUndefined(values);
    if (row[t.key] === undefined) row[t.key] = `${table}-${t.nextId++}`;
    const key = String(row[t.key]);
    if (t.rows.has(key)) throw new WorldError(`${table} ${key} already exists`);
    t.rows.set(key, row);
    return structuredClone(row);
  }

  update(table: string, key: string, set: Row): Row {
    const t = this.table(table);
    const row = t.rows.get(key);
    if (!row) throw new WorldError(`${table} ${key} not found`);
    Object.assign(row, pruneUndefined(set));
    return structuredClone(row);
  }

  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const [name, t] of this.tables) {
      out[name] = [...t.rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => structuredClone(row));
    }
    return out;
  }

  restore(snapshot: Snapshot): void {
    for (const [name, rows] of Object.entries(snapshot)) {
      const t = this.table(name);
      t.rows = new Map(rows.map((row) => [String(row[t.key]), structuredClone(row)]));
    }
  }

  keyOf(table: string): string {
    return this.table(table).key;
  }

  hasTable(table: string): boolean {
    return this.tables.has(table);
  }

  private table(name: string): Table {
    const t = this.tables.get(name);
    if (!t) throw new WorldError(`Unknown table ${name}`);
    return t;
  }
}

/** Row-level diff between two snapshots, used to show what an episode changed. */
export function diffSnapshots(before: Snapshot, after: Snapshot, keys: Record<string, string>): Change[] {
  const changes: Change[] = [];
  for (const table of Object.keys(after)) {
    const key = keys[table]!;
    const prev = new Map((before[table] ?? []).map((r) => [String(r[key]), r]));
    const next = new Map((after[table] ?? []).map((r) => [String(r[key]), r]));
    for (const [k, row] of next) {
      const old = prev.get(k);
      if (!old) changes.push({ table, key: k, kind: "insert", after: row });
      else if (JSON.stringify(old) !== JSON.stringify(row)) changes.push({ table, key: k, kind: "update", before: old, after: row });
    }
    for (const [k, row] of prev) if (!next.has(k)) changes.push({ table, key: k, kind: "delete", before: row });
  }
  return changes;
}
