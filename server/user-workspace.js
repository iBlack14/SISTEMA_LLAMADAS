/** One persistent operational workspace per authenticated account. */
export class UserWorkspaces {
  constructor({ getPool, getSessions, create, save, grant }) {
    Object.assign(this, { getPool, getSessions, create, save, grant });
    this.pending = new Map();
  }
  open(user, hint = "") {
    const key = String(user.id);
    if (!this.pending.has(key)) {
      const operation = this.resolve(user, hint).finally(() => this.pending.delete(key));
      this.pending.set(key, operation);
    }
    return this.pending.get(key);
  }
  async resolve(user, hint) {
    const pool = this.getPool();
    const sessions = this.getSessions();
    const [existing] = await pool.query(
      "SELECT session_code FROM auth_user_workspaces WHERE user_id=?", [user.id]);
    if (existing.length) {
      const code = existing[0].session_code;
      const session = sessions.get(code);
      if (!session) throw new Error("No se pudo recuperar tu espacio de trabajo. No se creó otro para evitar perder continuidad.");
      if (session.ownerUserId && String(session.ownerUserId) !== String(user.id))
        throw new Error("El espacio de trabajo pertenece a otra cuenta.");
      session.ownerUserId = user.id;
      return { code, session };
    }
    const [grants] = await pool.query(`SELECT a.session_code FROM auth_session_access a
      LEFT JOIN auth_user_workspaces w ON w.session_code=a.session_code
      WHERE a.user_id=? AND w.user_id IS NULL`, [user.id]);
    const candidates = grants.map(row => ({code: row.session_code, session: sessions.get(row.session_code)}))
      .filter(item => item.session && (!item.session.ownerUserId || String(item.session.ownerUserId) === String(user.id)));
    candidates.sort((a,b) => {
      const rich = item => Number(Boolean(item.session.contactBook || item.session.hasCallHistory));
      return rich(b) - rich(a) || Number(b.session.updatedAt || 0) - Number(a.session.updatedAt || 0);
    });
    const selected = candidates.find(item => item.code === hint) || candidates[0] || this.create();
    selected.session.ownerUserId = user.id;
    await this.grant(user, selected.code);
    // Persist the workspace before publishing its permanent account mapping.
    await this.save();
    await pool.query("INSERT INTO auth_user_workspaces(user_id,session_code) VALUES (?,?)",
      [user.id, selected.code]);
    return selected;
  }
}
