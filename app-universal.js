(() => {
  'use strict';
  const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.documentElement.classList.toggle('pwa-standalone', isInstalled());

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').then(() => { document.documentElement.dataset.pwaReady='true'; }).catch(() => { document.documentElement.dataset.pwaReady='false'; }));
  }

  let installPrompt = null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pwa-install-button';
  button.textContent = 'Instalează';
  button.setAttribute('aria-label', 'Instalează FamilyCare pe acest dispozitiv');

  function fallbackInstructions(){
    const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
    const text=isIOS
      ? 'În Safari, apasă Partajare și apoi „Adăugați pe ecranul principal”.'
      : 'În meniul browserului, alege „Instalează aplicația” sau „Adaugă pe ecranul principal”.';
    window.alert(text);
  }
  button.addEventListener('click', async () => {
    if (!installPrompt) { fallbackInstructions(); return; }
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    if(isInstalled()) button.hidden=true;
  });
  document.addEventListener('DOMContentLoaded', () => {
    (document.querySelector('.login-brand, .kiosk-brand') || document.body).appendChild(button);
    button.hidden=isInstalled();
  }, {once:true});
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt=event; button.hidden=isInstalled(); });
  window.addEventListener('appinstalled', () => { button.hidden=true; installPrompt=null; });
})();
