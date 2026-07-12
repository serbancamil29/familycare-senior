(() => {
  'use strict';
  document.documentElement.classList.toggle('pwa-standalone', window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true);

  async function getRuntimeConfig() {
    try {
      const r = await fetch('/api/runtime-config', { cache: 'no-store' });
      return r.ok ? await r.json() : {};
    } catch (_) { return {}; }
  }
  function localSeniorBaseUrl() {
    return `${location.protocol}//${location.hostname}:31001`;
  }
  function applySeniorLinks(baseUrl) {
    const base = String(baseUrl || localSeniorBaseUrl()).replace(/\/$/, '');
    document.querySelectorAll('a[href*="localhost:31001"],a[href*="127.0.0.1:31001"],a[data-senior-link]').forEach(link => {
      link.href = `${base}/pages/senior-login.html`;
      link.rel = 'noopener';
    });
  }
  function ensureMainNavigation() {
    const nav = document.querySelector('.sidebar .nav');
    if (!nav) return;
    const current = (location.pathname.split('/').pop() || 'dashboard.html').toLowerCase();
    const items = [
      ['dashboard.html', '🏠', 'Dashboard', 'dashboard'],
      ['network.html', '👪', 'Rețeaua mea', 'network'],
      ['journal.html', '📝', 'Jurnal', 'journal'],
      ['agenda.html', '📅', 'Agenda', 'agenda'],
      ['reports.html', '▦', 'Rapoarte', 'reports'],
      ['config.html', '⚙️', 'Configurări', 'config'],
      ['compliance.html', '✓', 'Conformitate', 'compliance'],
      ['#senior', '👤', 'Ecran Senior', 'senior']
    ];
    const markup = items.map(([href, icon, label, key]) => {
      const isSenior = key === 'senior';
      const active = !isSenior && current === href;
      const attrs = isSenior ? ' data-senior-link target="_blank" rel="noopener"' : '';
      return `<a class="${active ? 'active' : ''}" href="${href}"${attrs}><span class="ico">${icon}</span><span>${label}</span></a>`;
    }).join('');
    // V1.0.94: nu mai reconstruim meniul dacă are deja aceeași ordine; schimbăm doar active/href.
    // Asta elimină flicker-ul în care unele opțiuni dispar pentru o fracțiune de secundă la navigare.
    const currentLabels = Array.from(nav.querySelectorAll('a span:last-child')).map(x => x.textContent.trim()).join('|');
    const expectedLabels = items.map(x => x[2]).join('|');
    if (currentLabels !== expectedLabels) {
      nav.innerHTML = markup;
    } else {
      nav.querySelectorAll('a').forEach((a, index) => {
        const [href,, label, key] = items[index] || [];
        if (!href) return;
        const isSenior = key === 'senior';
        a.classList.toggle('active', !isSenior && current === href);
        a.href = href;
        if (isSenior) { a.dataset.seniorLink = 'true'; a.target = '_blank'; a.rel = 'noopener'; }
        const text = a.querySelector('span:last-child'); if (text) text.textContent = label;
      });
    }
  }
  function improveShellControls(cfg = {}) {
    const userName = String(cfg.userName || cfg.name || 'Utilizator autentificat');
    const orgName = String(cfg.headerName || cfg.organizationName || 'Organizație curentă');
    const orgCode = String(cfg.headerCode || '');
    document.querySelectorAll('.context-card').forEach(card => {
      if (card.closest('.modal') || card.classList.contains('keep-context-card')) return;
      const hasSelects = card.querySelector('.context-selects') || card.textContent.includes('ID organiza') || card.textContent.includes('Care Header');
      if (!hasSelects) return;
      card.classList.add('auth-context-card');
      card.innerHTML = `<div class="context-row"><div><span class="muted">Utilizator autentificat</span><br><b>${userName.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</b></div><span class="pill">${orgCode ? orgCode.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : 'Cont activ'}</span></div><div class="context-auth-org"><span>Organizație</span><strong>${orgName.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</strong></div>`;
    });
    document.querySelectorAll('.sidebar .brand').forEach(link => {
      link.href = 'company.html';
      link.title = 'Datele organiza\u021biei';
    });
    const shell = document.querySelector('.app-shell');
    const toggle = document.querySelector('.menu-toggle');
    if (shell && toggle) {
      const refresh = () => {
        const collapsed = shell.classList.contains('menu-collapsed');
        toggle.textContent = collapsed ? '\u203a' : '\u2039';
        toggle.title = collapsed ? 'Extinde meniul' : 'Restr\u00e2nge meniul';
        toggle.setAttribute('aria-label', toggle.title);
      };
      refresh();
      toggle.addEventListener('click', () => requestAnimationFrame(refresh));
    }
    // Tipărirea este disponibilă doar la nivel de raport, în pages/reports.html.
  }

  function setupGlobalThemeToggle() {
    const KEY = 'familycare-theme';
    document.querySelectorAll('.theme-switch').forEach(el => el.remove());
    let button = document.querySelector('.global-theme-toggle');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'global-theme-toggle';
      button.setAttribute('aria-label', 'Schimbă tema');
      button.setAttribute('title', 'Schimbă tema');
      document.body.appendChild(button);
    }
    const apply = theme => {
      const dark = theme === 'dark';
      document.documentElement.classList.toggle('dark-theme', dark);
      document.body.classList.toggle('dark-theme', dark);
      try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch (_) {}
      button.innerHTML = dark ? '<span aria-hidden="true">☀️</span>' : '<span aria-hidden="true">🌙</span>';
      button.setAttribute('aria-label', dark ? 'Activează tema luminoasă' : 'Activează tema întunecată');
      button.setAttribute('title', dark ? 'Tema luminoasă' : 'Tema întunecată');
    };
    let current = 'light';
    try { current = localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (_) {}
    apply(current);
    button.onclick = () => apply(document.documentElement.classList.contains('dark-theme') ? 'light' : 'dark');
  }

  function ensureAuthControls(cfg) {
    if (!cfg.authRequired || !document.querySelector('.sidebar') || document.querySelector('.sidebar-auth')) return;
    const box = document.createElement('div');
    box.className = 'sidebar-auth';
    box.innerHTML = `<span class="sidebar-auth-name">${String(cfg.authenticated ? (cfg.userName || cfg.name || 'Sesiune securizată') : 'Neautentificat')}</span><button type="button" class="sidebar-logout">Ieșire</button>`;
    box.querySelector('button').addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method:'DELETE' }); } catch (_) {}
      location.href = '/pages/main-login.html';
    });
    document.querySelector('.sidebar').appendChild(box);
  }
  document.addEventListener('DOMContentLoaded', async () => {
    const cfg = await getRuntimeConfig();
    ensureMainNavigation();
    setupGlobalThemeToggle();
    applySeniorLinks(cfg.seniorBaseUrl || '');
    improveShellControls(cfg);
    ensureAuthControls(cfg);
    document.querySelectorAll('.brand-version').forEach(el => { el.textContent = 'v' + (cfg.version || '3.0.0'); });
  }, { once: true });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').then(() => { document.documentElement.dataset.pwaReady='true'; }).catch(() => { document.documentElement.dataset.pwaReady='false'; }));
  }

  let installPrompt = null;
  const installButton = document.createElement('button');
  installButton.type = 'button';
  installButton.className = 'pwa-install-button';
  installButton.textContent = 'Instalează aplicația';
  installButton.hidden = true;
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(installButton);
  }, {once:true});
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => { installButton.hidden = true; installPrompt = null; });

  function labelResponsiveTables(root = document) {
    root.querySelectorAll('table').forEach(table => {
      const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (!headerRow) return;
      const headers = Array.from(headerRow.querySelectorAll('th')).map(cell => cell.textContent.trim());
      if (!headers.length) return;
      table.classList.add('responsive-table');
      table.querySelectorAll('tr').forEach(row => {
        if (row === headerRow) return;
        Array.from(row.children).forEach((cell, index) => {
          if (cell.tagName === 'TD' && !cell.hasAttribute('colspan') && !cell.dataset.label) {
            cell.dataset.label = headers[index] || '';
          }
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    labelResponsiveTables();
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; labelResponsiveTables(); });
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }, {once:true});

  // V1.0.94 - meniu stabil: pe desktop rămâne extins, iar click pe meniu nu îl restrânge automat.
  document.addEventListener('DOMContentLoaded', () => {
    const shell = document.querySelector('.app-shell');
    if (!shell) return;
    const mq = window.matchMedia('(max-width: 1000px)');
    function applyStableMenu() {
      if (!mq.matches) {
        shell.classList.remove('menu-collapsed');
        try { localStorage.setItem('familycare-menu-collapsed','0'); } catch (_) {}
      }
    }
    applyStableMenu();
    mq.addEventListener?.('change', applyStableMenu);
  }, {once:true});

})();
