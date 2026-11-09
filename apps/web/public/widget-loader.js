(() => {
  const script = document.currentScript;
  const publicKey = script?.getAttribute('data-public-key');
  if (!publicKey || !/^[a-f0-9-]{36}$/i.test(publicKey)) return;
  if (document.querySelector(`[data-smartdesk-widget="${publicKey}"]`)) return;
  const widgetOrigin = new URL(script.src).origin;
  const parentOrigin = location.origin;
  const channel = crypto.randomUUID();
  const storageKey = `smartdesk:visitor:${publicKey}:${parentOrigin}`;
  let state = {};
  let storageAvailable = true;
  let busy = false;
  let ready = false;
  let payload;
  let expired = false;
  let frame;
  const abort = new AbortController();
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (stored && typeof stored === 'object') state = stored;
  } catch {
    storageAvailable = false;
  }
  const box = document.createElement('aside');
  box.dataset.smartdeskWidget = publicKey;
  box.setAttribute('aria-label', 'SmartDesk 客服');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));z-index:2147483000;background:#fafbf8;border:1px solid #c7d0c9;border-radius:12px;box-shadow:0 12px 40px #19332e26;overflow:hidden;font:14px/1.6 sans-serif;color:#19332e';
  const toggle = document.createElement('button');
  toggle.textContent = 'SmartDesk · 联系客服';
  toggle.style.cssText =
    'display:block;width:100%;border:0;padding:14px 20px;background:#183f35;color:#fff;text-align:left;cursor:pointer;font:inherit';
  toggle.setAttribute('aria-expanded', 'true');
  const content = document.createElement('div');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.style.cssText = 'margin:12px 16px';
  const retry = document.createElement('button');
  retry.textContent = '重试连接';
  retry.hidden = true;
  retry.style.cssText = 'margin:0 16px 16px;padding:8px 16px;cursor:pointer';
  content.append(status, retry);
  box.append(toggle, content);
  document.body.append(box);
  toggle.onclick = () => {
    content.hidden = !content.hidden;
    toggle.setAttribute('aria-expanded', String(!content.hidden));
  };
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      storageAvailable = false;
    }
  }
  function deliver() {
    if (!abort.signal.aborted && ready && payload)
      frame.contentWindow.postMessage(
        {
          type: 'smartdesk:init',
          publicKey,
          channel,
          payload,
          storageAvailable,
        },
        widgetOrigin,
      );
  }
  function receive(event) {
    if (event.origin !== widgetOrigin || event.source !== frame?.contentWindow)
      return;
    const data = event.data;
    if (!data || data.publicKey !== publicKey || data.channel !== channel)
      return;
    if (data.type === 'smartdesk:ready') {
      ready = true;
      deliver();
    }
    if (data.type === 'smartdesk:refresh' && !busy) {
      payload = undefined;
      void connect();
    }
  }
  window.addEventListener('message', receive);
  async function request(path, options = {}) {
    const response = await fetch(
      `${widgetOrigin}/api/v1/public/widgets/${publicKey}${path}`,
      {
        ...options,
        signal: abort.signal,
        credentials: 'omit',
        cache: 'no-store',
      },
    );
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error?.message ?? '连接暂时不可用'), {
        code: value.error?.code,
      });
    return value.data;
  }
  async function connect() {
    if (busy) return;
    busy = true;
    retry.hidden = true;
    status.textContent = '正在连接客服入口…';
    try {
      const config = await request('');
      const iframeUrl = new URL(config.iframeUrl);
      if (
        iframeUrl.origin !== widgetOrigin ||
        iframeUrl.pathname !== `/widget/${publicKey}`
      )
        throw new Error('客服入口配置无效');
      if (!frame) {
        iframeUrl.searchParams.set('parentOrigin', parentOrigin);
        iframeUrl.searchParams.set('channel', channel);
        frame = document.createElement('iframe');
        frame.title = 'SmartDesk 访客咨询';
        frame.referrerPolicy = 'no-referrer';
        frame.src = iframeUrl.href;
        frame.style.cssText =
          'display:block;width:100%;height:540px;max-height:70vh;border:0';
        content.append(frame);
      }
      if (!state.pending) {
        state.pending = {
          commandId: crypto.randomUUID(),
          ...(state.token ? { resumeToken: state.token } : {}),
        };
        persist();
      }
      const pending = state.pending;
      const data = await request('/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pending.commandId,
        },
        body: JSON.stringify(
          pending.resumeToken ? { resumeToken: pending.resumeToken } : {},
        ),
      });
      const token = data.visitorToken ?? pending.resumeToken;
      if (!/^[a-f0-9]{64}$/.test(token ?? ''))
        throw new Error('访客身份响应无效');
      state = { token };
      persist();
      payload = { ...data, visitorToken: token };
      expired = false;
      status.textContent = '';
      deliver();
    } catch (error) {
      expired = ['BOOTSTRAP_RECEIPT_EXPIRED', 'INVALID_VISITOR_TOKEN'].includes(
        error.code,
      );
      status.textContent = expired
        ? '暂时无法恢复原咨询身份。开始新身份不会找回原有记录。'
        : '连接未完成，请重试。重试会保留本次请求。';
      retry.textContent = expired ? '开始新的咨询身份' : '重试连接';
      retry.hidden = false;
    } finally {
      busy = false;
    }
  }
  retry.onclick = () => {
    if (expired) {
      state = {};
      persist();
      payload = undefined;
    }
    void connect();
  };
  function dispose() {
    abort.abort();
    window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', dispose);
    box.remove();
  }
  box.addEventListener('smartdesk:dispose', dispose, { once: true });
  window.addEventListener('pagehide', dispose, { once: true });
  void connect();
})();
