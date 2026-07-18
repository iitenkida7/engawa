// engawa landing page — tiny vanilla JS: language toggle, sticky header
// state, and on-scroll reveal. No build step, no dependencies.
(() => {
  'use strict';

  const root = document.documentElement;
  const STORAGE_KEY = 'engawa-lp-lang';

  /* ------------------------------------------------------ language --- */
  const langButtons = Array.from(document.querySelectorAll('[data-lang-btn]'));

  function applyLang(lang) {
    const next = lang === 'en' ? 'en' : 'ja';
    root.setAttribute('data-lang', next);
    root.setAttribute('lang', next);
    for (const btn of langButtons) {
      btn.classList.toggle('active', btn.dataset.langBtn === next);
      btn.setAttribute('aria-pressed', String(btn.dataset.langBtn === next));
    }
  }

  // English is the primary language; a stored choice (e.g. Japanese) wins.
  const stored = localStorage.getItem(STORAGE_KEY);
  applyLang(stored || 'en');

  for (const btn of langButtons) {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.langBtn;
      applyLang(lang);
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch (_) {
        /* ignore private-mode storage errors */
      }
    });
  }

  /* -------------------------------------------------- sticky header --- */
  const header = document.getElementById('site-header');
  const onScroll = () => {
    if (header) header.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------------------------------------------------- reveal ------- */
  const reveals = Array.from(document.querySelectorAll('.reveal'));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce || !('IntersectionObserver' in window)) {
    for (const el of reveals) el.classList.add('is-visible');
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    for (const el of reveals) io.observe(el);
  }
})();
