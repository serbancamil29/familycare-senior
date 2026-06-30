(() => {
  'use strict';
  document.documentElement.classList.toggle('pwa-standalone', window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').then(() => { document.documentElement.dataset.pwaReady='true'; }).catch(() => { document.documentElement.dataset.pwaReady='false'; }));
  }
  let installPrompt = null;
  const installButton = document.createElement('button');
  installButton.type = 'button';
  installButton.className = 'pwa-install-button';
  installButton.textContent = 'Instalează FamilyCare Senior';
  installButton.hidden = true;
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(installButton), {once:true});
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => { installButton.hidden = true; installPrompt = null; });
})();
