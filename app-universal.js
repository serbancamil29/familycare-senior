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
  installButton.textContent = 'Instaleaz\u0103';
  installButton.setAttribute('aria-label', 'Instaleaz\u0103 FamilyCare Senior pe acest dispozitiv');
  installButton.hidden = true;
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });
  document.addEventListener('DOMContentLoaded', () => {
    const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const brand = document.querySelector('.kiosk-brand, .login-brand');
    (brand || document.body).appendChild(installButton);
    if (installed) installButton.hidden = true;
  }, {once:true});
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    installButton.hidden = installed;
  });
  window.addEventListener('appinstalled', () => { installButton.hidden = true; installPrompt = null; });
})();
