/**
 * Minimal Chrome DevTools Protocol client.
 *
 * No dependencies: Node 24 ships a global WebSocket, and `fetch` for the
 * HTTP discovery endpoints. This is enough to drive a real, already-running
 * browser (the one the operator is logged into), which is the whole point of
 * the fingerprint and slider modules: never launch a throwaway headless
 * profile when the task needs a session that looks like the user's.
 */

/** Error raised for CDP protocol failures, carrying the remote code/message. */
export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'unknown protocol error'}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

/**
 * List debuggable targets from a DevTools HTTP endpoint.
 * @param {string} endpoint e.g. "http://127.0.0.1:9222"
 * @returns {Promise<Array<{id:string,type:string,title:string,url:string,webSocketDebuggerUrl?:string}>>}
 */
export async function listTargets(endpoint) {
  const base = endpoint.replace(/\/+$/, '');
  const res = await fetch(`${base}/json/list`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`CDP discovery failed: ${res.status} ${res.statusText} (${base}/json/list)`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('CDP discovery returned a non-array payload');
  return body
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => ({
      id: t.id,
      type: t.type ?? 'unknown',
      title: t.title ?? '',
      url: t.url ?? '',
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    }));
}

/**
 * Pick the most useful page target: an http(s) page beats about:blank/devtools.
 * @param {Awaited<ReturnType<typeof listTargets>>} targets
 * @param {string} [preferId]
 */
export function pickPageTarget(targets, preferId) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (preferId) {
    const exact = pages.find((t) => t.id === preferId);
    if (exact) return exact;
    throw new Error(`no page target with id ${preferId}`);
  }
  const scored = pages
    .map((t) => {
      let score = 0;
      if (/^https?:/i.test(t.url)) score += 10;
      if (/^about:blank$/i.test(t.url)) score += 1;
      if (/^(chrome|devtools|edge|about):/i.test(t.url)) score -= 5;
      return { t, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error('no attachable page target found on that endpoint');
  return scored[0].t;
}

/**
 * One CDP connection with request/response correlation and event fan-out.
 * Events are delivered by method name; `Runtime.exceptionThrown` and friends
 * land in `on(...)` handlers registered by the caller.
 */
export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;

  /** @param {WebSocket} ws */
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => this.#onClose());
  }

  /**
   * Attach to a page target.
   * @param {string} wsUrl
   * @param {{timeoutMs?: number}} [opts]
   */
  static async connect(wsUrl, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout after ${timeoutMs}ms`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${wsUrl}`));
      });
    });
    return new CdpClient(ws);
  }

  /** @param {string} method @param {(params:any)=>void} fn */
  on(method, fn) {
    const list = this.#handlers.get(method) ?? [];
    list.push(fn);
    this.#handlers.set(method, list);
    return () => {
      const cur = this.#handlers.get(method) ?? [];
      this.#handlers.set(
        method,
        cur.filter((f) => f !== fn),
      );
    };
  }

  /**
   * Send one protocol command and await its result.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{timeoutMs?: number, sessionId?: string}} [opts]
   */
  send(method, params = {}, opts = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP session is closed'));
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (opts.sessionId) payload.sessionId = opts.sessionId;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression, opts = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? true,
        userGesture: opts.userGesture ?? false,
      },
      { timeoutMs: opts.timeoutMs ?? 30_000 },
    );
    if (res.exceptionDetails) {
      const text =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        'evaluation threw';
      throw new Error(`page evaluation failed: ${text}`);
    }
    return res.result?.value;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
    this.#onClose();
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.id != null) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new CdpError(pending.method, msg.error));
      else pending.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      for (const fn of this.#handlers.get(msg.method) ?? []) {
        try {
          fn(msg.params, msg.sessionId);
        } catch {
          /* a broken observer must not kill the socket */
        }
      }
    }
  }

  #onClose() {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: CDP socket closed`));
    }
    this.#pending.clear();
  }
}

/**
 * Convenience: discover, pick a page, attach.
 * @param {string} endpoint
 * @param {{targetId?: string, timeoutMs?: number}} [opts]
 */
export async function attach(endpoint, opts = {}) {
  const targets = await listTargets(endpoint);
  const target = pickPageTarget(targets, opts.targetId);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, {
    timeoutMs: opts.timeoutMs,
  });
  return { client, target, targets };
}
