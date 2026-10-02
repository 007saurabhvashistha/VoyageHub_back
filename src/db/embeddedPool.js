export class EmbeddedPostgresPool {
  constructor(database) {
    this.database = database;
    this.queue = Promise.resolve();
  }

  async acquire() {
    let release;
    const previous = this.queue;
    const ticket = new Promise((resolve) => { release = resolve; });
    this.queue = previous.then(() => ticket);
    await previous;
    return release;
  }

  async query(text, values = []) {
    const release = await this.acquire();
    try {
      const result = await this.database.query(text, values);
      return {
        ...result,
        rowCount: result.rowCount ?? result.affectedRows ?? result.rows?.length ?? 0,
      };
    } finally {
      release();
    }
  }

  async exec(text) {
    const release = await this.acquire();
    try {
      return await this.database.exec(text);
    } finally {
      release();
    }
  }

  async connect() {
    const releaseLock = await this.acquire();
    let released = false;
    return {
      query: async (text, values = []) => {
        const result = await this.database.query(text, values);
        return {
          ...result,
          rowCount: result.rowCount ?? result.affectedRows ?? result.rows?.length ?? 0,
        };
      },
      release: () => {
        if (released) return;
        released = true;
        releaseLock();
      },
    };
  }

  async end() {
    await this.queue;
    await this.database.close();
  }
}