/**
 * DeskStart — 验收工具公共库：极简 CDP 客户端（仅依赖 Node 22 内置能力）
 * 供 screenshot.mjs / smoke.mjs 使用。
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
    this.consoleErrors = [];
    this.exceptions = [];
    this.requests = [];
    // 预期内的资源加载失败（收藏站点的图标探测），不计入控制台错误
    this.expectedResourceErrors = [];
    ws.addEventListener("message", (ev) => this.#handle(JSON.parse(ev.data)));
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
    });
    return new CDP(ws);
  }

  static async connectPage(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("找不到 page 目标");
    return CDP.connect(page.webSocketDebuggerUrl);
  }

  #handle(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "?").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      this.exceptions.push(d.exception?.description || d.text);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const text = `[log] ${msg.params.entry.text} ${msg.params.entry.url || ""}`;
      // 图标探测失败（站点没有 favicon / 域名解析不了）属于预期路径，单独统计
      if (/\/favicon\.(ico|png)\b/i.test(text)) this.expectedResourceErrors.push(text);
      else this.consoleErrors.push(text);
    }
    if (msg.method === "Network.requestWillBeSent") {
      this.requests.push(msg.params.request.url);
    }
    for (const w of [...this.waiters]) {
      if (w.method === msg.method) {
        w.resolve(msg.params);
        clearTimeout(w.timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
      }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`wait ${method} timeout`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async click(selector) {
    const ok = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`
    );
    if (!ok) throw new Error(`click: 未找到元素 ${selector}`);
  }

  async setInput(selector, value) {
    await this.eval(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()
    `);
  }

  async setRange(selector, value) {
    await this.eval(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, String(${Number(value)}));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()
    `);
  }

  async pressKey(key, code, keyCode, text) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", ...(text ? { text } : {}) });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async mouseMoveTo(selector) {
    const raw = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2 - 40, y: r.y + r.height / 2 }); })()`
    );
    if (!raw) throw new Error(`hover: 未找到元素 ${selector}`);
    const { x, y } = JSON.parse(raw);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }

  async navigate(url) {
    const current = await this.eval("location.href").catch(() => null);
    const loaded = this.waitEvent("Page.loadEventFired", 10000).catch(() => null);
    if (current === url) {
      await this.send("Page.reload", { ignoreCache: true });
    } else {
      await this.send("Page.navigate", { url });
    }
    await loaded;
    // 兜底：等待文档就绪（本地页面极快，避免依赖单一事件）
    for (let i = 0; i < 40; i++) {
      const ready = await this.eval("document.readyState").catch(() => null);
      if (ready === "complete") break;
      await sleep(100);
    }
    await sleep(400);
  }
}
