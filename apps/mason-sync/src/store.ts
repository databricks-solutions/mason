// Session store: interface + Postgres (Lakebase) and in-memory implementations.
//
// The in-memory store powers unit tests and `MASON_SYNC_STORE=memory` local
// dev (desktop e2e without Postgres). The Postgres store is the production
// path on Lakebase.

import type { SessionRow, StoredItem, SyncItem, SessionUpsertBody } from "../shared/protocol";

export interface Store {
  ready(): boolean;
  upsertSession(user: string, id: string, body: SessionUpsertBody): Promise<SessionRow>;
  deleteSession(user: string, id: string): Promise<boolean>;
  listSessions(user: string, limit: number): Promise<SessionRow[]>;
  getSession(user: string, id: string): Promise<SessionRow | null>;
  // Returns only the items that were newly inserted (duplicates by id are
  // acked but not re-inserted, and not returned — fanout must not re-emit).
  appendItems(user: string, sessionId: string, items: SyncItem[], replace: boolean): Promise<StoredItem[]>;
  listItems(user: string, sessionId: string, afterPosition: number, limit: number): Promise<StoredItem[]>;
  close(): Promise<void>;
}

export class NotFoundError extends Error {}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface MemSession {
  row: SessionRow;
  user: string;
  deleted: boolean;
  items: StoredItem[];
  ids: Set<string>;
}

export class MemStore implements Store {
  private sessions = new Map<string, MemSession>();

  ready(): boolean {
    return true;
  }

  private owned(user: string, id: string): MemSession | null {
    const s = this.sessions.get(id);
    if (!s || s.user !== user || s.deleted) return null;
    return s;
  }

  async upsertSession(user: string, id: string, body: SessionUpsertBody): Promise<SessionRow> {
    const now = new Date().toISOString();
    let s = this.sessions.get(id);
    if (s && s.user !== user) throw new NotFoundError();
    if (!s) {
      s = {
        user,
        deleted: false,
        items: [],
        ids: new Set(),
        row: {
          id,
          title: body.title || "New chat",
          model_label: body.model_label ?? null,
          workspace_host: body.workspace_host ?? null,
          created_at: now,
          updated_at: now,
        },
      };
      this.sessions.set(id, s);
    } else {
      s.deleted = false;
      s.row.title = body.title || s.row.title;
      if (body.model_label !== undefined) s.row.model_label = body.model_label;
      if (body.workspace_host !== undefined) s.row.workspace_host = body.workspace_host;
      s.row.updated_at = now;
    }
    return { ...s.row };
  }

  async deleteSession(user: string, id: string): Promise<boolean> {
    const s = this.owned(user, id);
    if (!s) return false;
    s.deleted = true;
    s.row.updated_at = new Date().toISOString();
    return true;
  }

  async listSessions(user: string, limit: number): Promise<SessionRow[]> {
    return [...this.sessions.values()]
      .filter((s) => s.user === user && !s.deleted)
      .sort((a, b) => b.row.updated_at.localeCompare(a.row.updated_at))
      .slice(0, limit)
      .map((s) => ({ ...s.row }));
  }

  async getSession(user: string, id: string): Promise<SessionRow | null> {
    const s = this.owned(user, id);
    return s ? { ...s.row } : null;
  }

  async appendItems(
    user: string,
    sessionId: string,
    items: SyncItem[],
    replace: boolean
  ): Promise<StoredItem[]> {
    const s = this.owned(user, sessionId);
    if (!s) throw new NotFoundError();
    if (replace) {
      s.items = [];
      s.ids.clear();
    }
    const inserted: StoredItem[] = [];
    let nextPos = s.items.length > 0 ? s.items[s.items.length - 1].position + 1 : 0;
    for (const item of items) {
      if (s.ids.has(item.id)) continue; // idempotent re-POST
      const stored: StoredItem = {
        ...item,
        session_id: sessionId,
        position: nextPos++,
        origin: "desktop",
        created_at: new Date().toISOString(),
      };
      s.items.push(stored);
      s.ids.add(item.id);
      inserted.push(stored);
    }
    if (inserted.length > 0) s.row.updated_at = new Date().toISOString();
    return inserted;
  }

  async listItems(
    user: string,
    sessionId: string,
    afterPosition: number,
    limit: number
  ): Promise<StoredItem[]> {
    const s = this.owned(user, sessionId);
    if (!s) throw new NotFoundError();
    return s.items.filter((i) => i.position > afterPosition).slice(0, limit);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Postgres (Lakebase) store
// ---------------------------------------------------------------------------

import type { Pool } from "pg";

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  user_email     TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT 'New chat',
  model_label    TEXT,
  workspace_host TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_updated ON sessions (user_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_items (
  id          TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  position    INTEGER NOT NULL,
  type        TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'desktop',
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_items_pos ON session_items (session_id, position);
`;

function rowToSession(r: any): SessionRow {
  return {
    id: r.id,
    title: r.title,
    model_label: r.model_label,
    workspace_host: r.workspace_host,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function rowToItem(r: any): StoredItem {
  return {
    id: r.id,
    session_id: r.session_id,
    position: r.position,
    type: r.type,
    origin: r.origin,
    data: r.data,
    created_at: r.created_at.toISOString(),
  };
}

export class PgStore implements Store {
  private isReady = false;
  constructor(private pool: Pool) {}

  async bootstrap(): Promise<void> {
    await this.pool.query(BOOTSTRAP_SQL);
    this.isReady = true;
  }

  ready(): boolean {
    return this.isReady;
  }

  async upsertSession(user: string, id: string, body: SessionUpsertBody): Promise<SessionRow> {
    // Ownership: the WHERE on conflict ensures another user's id can't be
    // hijacked — the update matches zero rows and we detect it below.
    const res = await this.pool.query(
      `INSERT INTO sessions (id, user_email, title, model_label, workspace_host)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         model_label = COALESCE(EXCLUDED.model_label, sessions.model_label),
         workspace_host = COALESCE(EXCLUDED.workspace_host, sessions.workspace_host),
         deleted_at = NULL,
         updated_at = now()
       WHERE sessions.user_email = $2
       RETURNING *`,
      [id, user, body.title || "New chat", body.model_label ?? null, body.workspace_host ?? null]
    );
    if (res.rowCount === 0) throw new NotFoundError();
    return rowToSession(res.rows[0]);
  }

  async deleteSession(user: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE sessions SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND user_email = $2 AND deleted_at IS NULL`,
      [id, user]
    );
    return (res.rowCount || 0) > 0;
  }

  async listSessions(user: string, limit: number): Promise<SessionRow[]> {
    const res = await this.pool.query(
      `SELECT * FROM sessions WHERE user_email = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT $2`,
      [user, limit]
    );
    return res.rows.map(rowToSession);
  }

  async getSession(user: string, id: string): Promise<SessionRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND user_email = $2 AND deleted_at IS NULL`,
      [id, user]
    );
    return res.rows[0] ? rowToSession(res.rows[0]) : null;
  }

  async appendItems(
    user: string,
    sessionId: string,
    items: SyncItem[],
    replace: boolean
  ): Promise<StoredItem[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const own = await client.query(
        `SELECT 1 FROM sessions WHERE id = $1 AND user_email = $2 AND deleted_at IS NULL FOR UPDATE`,
        [sessionId, user]
      );
      if (own.rowCount === 0) throw new NotFoundError();
      if (replace) {
        await client.query(`DELETE FROM session_items WHERE session_id = $1`, [sessionId]);
      }
      const posRes = await client.query(
        `SELECT COALESCE(MAX(position), -1) AS max FROM session_items WHERE session_id = $1`,
        [sessionId]
      );
      let nextPos = Number(posRes.rows[0].max) + 1;
      const inserted: StoredItem[] = [];
      for (const item of items) {
        const res = await client.query(
          `INSERT INTO session_items (id, session_id, position, type, origin, data)
           VALUES ($1, $2, $3, $4, 'desktop', $5)
           ON CONFLICT (session_id, id) DO NOTHING
           RETURNING *`,
          [item.id, sessionId, nextPos, item.type, JSON.stringify(item.data)]
        );
        if (res.rowCount === 1) {
          nextPos += 1;
          inserted.push(rowToItem(res.rows[0]));
        }
      }
      if (inserted.length > 0) {
        await client.query(`UPDATE sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
      }
      await client.query("COMMIT");
      return inserted;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async listItems(
    user: string,
    sessionId: string,
    afterPosition: number,
    limit: number
  ): Promise<StoredItem[]> {
    const own = await this.pool.query(
      `SELECT 1 FROM sessions WHERE id = $1 AND user_email = $2 AND deleted_at IS NULL`,
      [sessionId, user]
    );
    if (own.rowCount === 0) throw new NotFoundError();
    const res = await this.pool.query(
      `SELECT * FROM session_items WHERE session_id = $1 AND position > $2
       ORDER BY position ASC LIMIT $3`,
      [sessionId, afterPosition, limit]
    );
    return res.rows.map(rowToItem);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
