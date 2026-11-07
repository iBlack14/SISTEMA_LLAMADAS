/** Serializes phone events and only releases receipts after durable persistence. */
export class CallHistoryGate {
  constructor(persistence, getSessions) {
    this.persistence = persistence;
    this.getSessions = getSessions;
    this.queues = new Map();
    this.locks = new Map();
    this.failed = new Set();
    this.receipts = new Map();
    this.retrying = false;
  }
  blocked(code) {
    return Boolean(this.locks.get(code) || this.failed.has(code) || this.persistence.status().mode === "pending");
  }
  serialize(code, task) {
    this.locks.set(code, (this.locks.get(code) || 0) + 1);
    const previous = this.queues.get(code) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const finished = operation.finally(() => {
      const count = (this.locks.get(code) || 1) - 1;
      if (count) this.locks.set(code, count);
      else this.locks.delete(code);
      if (this.queues.get(code) === finished) this.queues.delete(code);
    });
    this.queues.set(code, finished);
    return finished;
  }
  flush(code) {
    for (const [key, receipt] of this.receipts) {
      if (receipt.code !== code) continue;
      this.receipts.delete(key);
      try { receipt.afterCommit(); } catch (error) { console.error("[HISTORY_RECEIPT]", error.code || "RECEIPT_FAILED"); }
    }
  }
  async commit(code, key, afterCommit) {
    this.receipts.set(JSON.stringify([code,key]), { code, afterCommit });
    try {
      await this.persistence.save(this.getSessions());
      this.failed.delete(code);
      this.flush(code);
    } catch (error) {
      this.failed.add(code);
      throw error;
    }
  }
  async retryPending() {
    if (this.retrying || this.locks.size || (!this.failed.size && this.persistence.status().mode !== "pending")) return;
    this.retrying = true;
    try {
      await this.persistence.save(this.getSessions());
      for (const code of [...this.failed]) {
        this.failed.delete(code);
        this.flush(code);
      }
    } finally { this.retrying = false; }
  }
}
