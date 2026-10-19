// engawa landing page — tiny vanilla JS: language preference, sticky header
// state, and on-scroll reveal. No build step, no dependencies.
(() => {
  'use strict';

  /* ------------------------------------------------------ language --- */
  // English (/) and Japanese (/ja/) are separate pages. Remember an explicit
  // choice, and send returning Japanese readers from the English page to /ja/.
  const STORAGE_KEY = 'engawa-lp-lang';
  const pageLang = document.documentElement.lang === 'ja' ? 'ja' : 'en';
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    /* ignore private-mode storage errors */
  }
  if (pageLang === 'en' && stored === 'ja') {
    location.replace('ja/' + location.hash);
    return;
  }
  for (const link of document.querySelectorAll('[data-lang-link]')) {
    link.addEventListener('click', () => {
      try {
        localStorage.setItem(STORAGE_KEY, link.dataset.langLink);
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
