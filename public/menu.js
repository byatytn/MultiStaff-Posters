(() => {
  if (window.__managerAssistMenuLoaded) return;
  window.__managerAssistMenuLoaded = true;

  const style = document.createElement('style');
  style.textContent = `
    .ma-menu-button{position:fixed;left:16px;top:14px;z-index:1001;width:38px;height:38px;border:1px solid #29303a;border-radius:9px;background:#11151a;color:#dce2e9;display:grid;place-items:center;font-size:18px;line-height:1;box-shadow:0 8px 24px #0006;cursor:pointer;transition:.16s ease}
    .ma-menu-button:hover{border-color:#ef3038;background:#1b1215;transform:translateY(-1px)}
    .ma-menu-button:active{transform:translateY(0)}
    .ma-menu-button span{display:block;transform:translateY(-1px)}
    .ma-menu-overlay{position:fixed;inset:0;background:#0008;z-index:999;opacity:0;visibility:hidden;transition:opacity .18s ease,visibility .18s ease}
    .ma-menu-overlay.open{opacity:1;visibility:visible}
    .ma-menu-drawer{position:fixed;left:0;top:0;bottom:0;width:min(310px,88vw);z-index:1000;background:#0d1014;border-right:1px solid #29303a;box-shadow:24px 0 70px #0009;transform:translateX(-105%);transition:transform .22s cubic-bezier(.22,.61,.36,1);padding:22px 16px}
    .ma-menu-drawer.open{transform:translateX(0)}
    .ma-menu-head{padding:2px 10px 20px;border-bottom:1px solid #252b34;margin-bottom:12px}
    .ma-menu-brand{font-weight:900;letter-spacing:.8px;font-size:21px;color:#f5f7fa}.ma-menu-brand i{font-style:normal;color:#ef3038}.ma-menu-sub{font-size:9px;color:#737d8a;letter-spacing:1.5px;margin-top:3px}
    .ma-menu-section{font-size:10px;color:#697383;letter-spacing:1.8px;text-transform:uppercase;padding:9px 10px 7px}
    .ma-menu-link{display:flex;align-items:center;gap:11px;width:100%;border:1px solid transparent;border-radius:10px;padding:12px 11px;background:transparent;color:#cbd2dc;text-decoration:none;font-size:13px;font-weight:700;cursor:pointer;transition:.16s ease}
    .ma-menu-link:hover{background:#151a20;border-color:#29303a;color:#fff}.ma-menu-link.active{background:#241216;border-color:#7b242c;color:#fff}.ma-menu-icon{width:24px;text-align:center;font-size:16px}.ma-menu-close{position:absolute;right:13px;top:17px;width:32px;height:32px;border:1px solid #29303a;border-radius:8px;background:#11151a;color:#aeb6c2;cursor:pointer}.ma-menu-close:hover{border-color:#ef3038;color:#fff}
    @media(max-width:600px){.ma-menu-button{left:10px;top:10px}.ma-menu-drawer{padding:17px 12px}.ma-menu-head{padding-left:9px}}
  `;
  document.head.appendChild(style);

  const existing = document.querySelector('.ma-menu-button') ||
    document.querySelector('button[aria-label*="меню" i]') ||
    document.querySelector('button[title*="меню" i]');

  let button = existing;
  if (!button) {
    button = document.createElement('button');
    button.className = 'ma-menu-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Открыть меню');
    button.innerHTML = '<span>☰</span>';
    document.body.appendChild(button);
  } else {
    button.classList.add('ma-menu-button');
  }

  const top = document.querySelector('.top');
  if (top && !existing) top.style.paddingLeft = '68px';

  const overlay = document.createElement('div');
  overlay.className = 'ma-menu-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const drawer = document.createElement('aside');
  drawer.className = 'ma-menu-drawer';
  drawer.setAttribute('aria-label', 'Навигация ManagerAssist');
  const path = window.location.pathname.toLowerCase();
  drawer.innerHTML = `
    <button class="ma-menu-close" type="button" aria-label="Закрыть меню">×</button>
    <div class="ma-menu-head"><div class="ma-menu-brand">MANAGER<i>ASSIST</i></div><div class="ma-menu-sub">АТМОСФЕРА</div></div>
    <div class="ma-menu-section">Разделы</div>
    <a class="ma-menu-link ${path === '/' || path === '/index.html' ? 'active' : ''}" href="/">
      <span class="ma-menu-icon">⌂</span><span>Главное меню</span>
    </a>
    <a class="ma-menu-link ${path.includes('/notes') ? 'active' : ''}" href="/notes.html">
      <span class="ma-menu-icon">▤</span><span>Заметки</span>
    </a>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  const setOpen = open => {
    overlay.classList.toggle('open', open);
    drawer.classList.toggle('open', open);
    overlay.setAttribute('aria-hidden', String(!open));
    document.body.style.overflow = open ? 'hidden' : '';
  };

  button.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  overlay.addEventListener('click', () => setOpen(false));
  drawer.querySelector('.ma-menu-close').addEventListener('click', () => setOpen(false));
  drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
})();
