// 用户脚本界面与存储适配。核心填选逻辑仍来自 content/，不复制另一份实现。
function createShell(popupHtml, optionsHtml) {
  const host = document.createElement('div');
  host.id = 'ugh-userscript-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #27324b;
        pointer-events: none; color-scheme: light; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button { font: inherit; }
      button:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 3px; }
      #ugh-launcher { display: flex; align-items: center; gap: 9px; padding: 10px 14px;
        border: 1px solid #355ac2; border-radius: 14px; background: #3f66d5;
        color: white; cursor: grab; box-shadow: 0 4px 16px #294caa30, 0 1px 3px #24357822;
        pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
      #ugh-launcher:hover { background: #3156bc; }
      #ugh-launcher.dragging { cursor: grabbing; box-shadow: 0 9px 25px #3949ab45; }
      .ugh-launcher-icon { display: grid; place-items: center; width: 26px; height: 26px;
        border-radius: 8px; background: #ffffff21; font-size: 16px; font-weight: 700; line-height: 1; }
      .ugh-launcher-text { font-weight: 600; letter-spacing: .4px; }
      .ugh-grip { opacity: .6; font-size: 15px; letter-spacing: -3px; padding-right: 3px; }
      #ugh-panel { position: fixed; width: min(392px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
        overflow: auto; overscroll-behavior: contain; border: 1px solid #dfe5ef; border-radius: 16px;
        background: #fff; box-shadow: 0 16px 48px #23386722, 0 3px 12px #23386710; pointer-events: auto;
        scrollbar-width: thin; scrollbar-color: #c9d3e4 transparent; }
      #ugh-panel.settings { width: min(760px, calc(100vw - 24px)); }
      #ugh-toolbar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: flex-end; gap: 6px;
        padding: 9px 14px; border-bottom: 1px solid #edf0f5; background: #fff; }
      .ugh-toolbar-label { margin-right: auto; color: #63728a; font-size: 11px; font-weight: 600; letter-spacing: .5px; }
      #ugh-toolbar button { min-height: 28px; padding: 3px 9px; border: 0; border-radius: 6px;
        background: #f1f4f9; color: #53627b; cursor: pointer; font-size: 12px; }
      #ugh-toolbar button:hover { color: #4263eb; background: #edf0ff; }
      .ugh-popup { padding: 16px 18px; }
      .ugh-note { margin: 0; padding: 10px 18px; border-top: 1px solid #edf0f5;
        background: #f8fafc; font-size: 11px; line-height: 1.6; color: #63728a; }
      @media (prefers-reduced-motion: no-preference) { #ugh-launcher { transition: box-shadow .15s, background .15s; } }
    </style>
    <section id="ugh-panel" aria-label="USTC评教助手" hidden>
      <div id="ugh-toolbar"><span class="ugh-toolbar-label">问卷速填 · 非官方工具</span><button id="ugh-back" hidden>← 返回</button><button id="ugh-close" aria-label="收起评教助手" title="收起面板（Esc）">收起</button></div>
      <div class="ugh-popup">${popupHtml}</div>
      <div id="ugh-options-host" hidden></div>
      <p class="ugh-note">请按实际情况调整答案 · 拖动下方入口可移动面板</p>
    </section>
    <button id="ugh-launcher" aria-expanded="false" aria-controls="ugh-panel" title="点击打开，拖动调整位置"><span class="ugh-launcher-icon" aria-hidden="true">✓</span><span class="ugh-launcher-text">评教助手</span><span class="ugh-grip" aria-hidden="true">⠿</span></button>`;
  const optionsHost = root.getElementById('ugh-options-host');
  const optionsRoot = optionsHost.attachShadow({ mode: 'open' });
  optionsRoot.innerHTML = `<div class="ugh-options">${optionsHtml}</div><style>
    :host { display: block; color-scheme: light; } * { box-sizing: border-box; } [hidden] { display: none !important; }
    .ugh-options { padding: 18px; }
  </style>`;
  document.documentElement.appendChild(host);

  function scope(node) {
    return {
      getElementById: id => node.querySelector('#' + id),
      querySelectorAll: selector => node.querySelectorAll(selector),
      createElement: name => document.createElement(name)
    };
  }
  const panel = root.getElementById('ugh-panel');
  const popup = root.querySelector('.ugh-popup');
  const autoSubmit = popup.querySelector('#autosubmit');
  const launcher = root.getElementById('ugh-launcher');
  const back = root.getElementById('ugh-back');
  let timer;
  let pageKey = '';
  let launcherPosition = { right: 16, bottom: 16 };
  let positionTouched = false;
  let drag = null;
  let suppressClick = false;
  let suppressClickTimer;
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  function viewport() {
    return { width: document.documentElement.clientWidth || innerWidth,
      height: document.documentElement.clientHeight || innerHeight };
  }

  function placePanel() {
    if (panel.hidden) return;
    const { width, height } = viewport();
    const margin = Math.min(12, width / 4, height / 4);
    const anchor = launcher.getBoundingClientRect();
    const above = Math.max(0, anchor.top - margin - 10);
    const below = Math.max(0, height - anchor.bottom - margin - 10);
    // Keep the launcher accessible even when the panel needs to scroll.
    panel.style.maxHeight = Math.max(above, below) + 'px';
    const bounds = panel.getBoundingClientRect();
    const left = clamp(anchor.right - bounds.width, margin, Math.max(margin, width - bounds.width - margin));
    let top = anchor.top - bounds.height - 10;
    if (top < margin && below >= bounds.height) top = anchor.bottom + 10;
    top = clamp(top, margin, Math.max(margin, height - bounds.height - margin));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function placeLauncher() {
    const { width, height } = viewport();
    const bounds = launcher.getBoundingClientRect();
    const maxRight = Math.max(0, width - bounds.width - 12);
    const maxBottom = Math.max(0, height - bounds.height - 12);
    launcherPosition.right = clamp(launcherPosition.right, Math.min(12, maxRight), maxRight);
    launcherPosition.bottom = clamp(launcherPosition.bottom, Math.min(12, maxBottom), maxBottom);
    host.style.right = launcherPosition.right + 'px';
    host.style.bottom = launcherPosition.bottom + 'px';
    placePanel();
  }

  function savePosition() {
    // Some script managers reject storage access; the current session must remain usable.
    try { Promise.resolve(GM.setValue('launcherPosition', { ...launcherPosition })).catch(() => {}); }
    catch (_) {}
  }

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    launcher.classList.remove('dragging');
    if (launcher.hasPointerCapture && launcher.hasPointerCapture(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
    if (moved) {
      savePosition();
      // The compatibility click follows pointerup. Consume only that click, then allow a real click.
      suppressClick = true;
      clearTimeout(suppressClickTimer);
      suppressClickTimer = setTimeout(() => { suppressClick = false; }, 500);
    }
  }

  const shell = {
    popupDocument: scope(popup),
    optionsDocument: scope(optionsRoot),
    refresh: null,
    scheduleRefresh() {
      const key = location.href + [...document.querySelectorAll(window.SELECTORS.activeTeacher)]
        .map(el => el.textContent).join('|');
      if (key !== pageKey) {
        autoSubmit.checked = false;
        pageKey = key;
        popup.querySelector('#msg').textContent = '';
        window.__ugh.clearMarks();
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (shell.refresh) shell.refresh().catch(() => {});
      }, 150);
    },
    show(settings = false) {
      if (settings) window.__ugh.stopBatch();
      autoSubmit.checked = false;
      panel.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      popup.hidden = settings;
      optionsHost.hidden = !settings;
      back.hidden = !settings;
      panel.classList.toggle('settings', settings);
      panel.scrollTop = 0;
      placePanel();
      shell.scheduleRefresh();
    },
    close() {
      autoSubmit.checked = false;
      panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
      launcher.focus({ preventScroll: true });
    },
    start() {
      launcher.addEventListener('pointerdown', event => {
        if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
        positionTouched = true;
        suppressClick = false;
        clearTimeout(suppressClickTimer);
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          right: launcherPosition.right, bottom: launcherPosition.bottom, moved: false };
        try { launcher.setPointerCapture(event.pointerId); } catch (_) {}
      });
      launcher.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        event.preventDefault();
        launcher.classList.add('dragging');
        launcherPosition = { right: drag.right - dx, bottom: drag.bottom - dy };
        placeLauncher();
      });
      launcher.addEventListener('pointerup', finishDrag);
      launcher.addEventListener('pointercancel', finishDrag);
      launcher.addEventListener('lostpointercapture', finishDrag);
      launcher.onclick = event => {
        if (suppressClick && event.detail !== 0) {
          suppressClick = false;
          clearTimeout(suppressClickTimer);
          event.preventDefault();
          return;
        }
        panel.hidden ? shell.show() : shell.close();
      };
      root.getElementById('ugh-close').onclick = () => shell.close();
      back.onclick = () => shell.show();
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.isComposing && !panel.hidden) {
          event.stopPropagation();
          shell.close();
        }
      });
      // popup 的 onclick 已先读取本次勾选；点击后立即复位，下一次须重新勾选。
      for (const id of ['apply', 'refill']) {
        const button = popup.querySelector('#' + id);
        if (button) button.addEventListener('click', () => { autoSubmit.checked = false; });
      }
      new MutationObserver(() => {
        if (!host.isConnected) document.documentElement.appendChild(host);
        shell.scheduleRefresh();
      }).observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'disabled', 'hidden', 'aria-selected'] });
      document.addEventListener('input', shell.scheduleRefresh);
      document.addEventListener('change', shell.scheduleRefresh);
      document.addEventListener('keyup', e => {
        if (!panel.hidden && !optionsHost.hidden && (e.key === 'Enter' || e.key === 'Backspace')) e.stopImmediatePropagation();
      }, true);
      addEventListener('resize', () => {
        placeLauncher();
        if (positionTouched) savePosition();
      });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(placePanel).observe(panel);
      placeLauncher();
      try {
        Promise.resolve(GM.getValue('launcherPosition', null)).then(saved => {
          if (positionTouched || !saved || typeof saved.right !== 'number' || typeof saved.bottom !== 'number' ||
              !Number.isFinite(saved.right) || !Number.isFinite(saved.bottom)) return;
          launcherPosition = { right: saved.right, bottom: saved.bottom };
          placeLauncher();
        }).catch(() => {});
      } catch (_) {}
      addEventListener('hashchange', shell.scheduleRefresh);
      GM.registerMenuCommand('USTC评教助手：打开面板', () => shell.show());
      GM.registerMenuCommand('USTC评教助手：规则设置', () => shell.show(true));
      shell.scheduleRefresh();
    }
  };
  return shell;
}
