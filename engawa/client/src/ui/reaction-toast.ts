// Gather-style reaction toasts (#221): a name + emoji pill that floats up and
// fades at the bottom-left, stacking when several arrive at once. Rendered as a
// DOM overlay above the screenshare / camera panels so reactions stay visible
// during a call (the on-map above-avatar bubbles are hidden behind those
// panels). The container is created lazily and reused for the page's lifetime.

import { REACTION_LIFETIME_MS } from '@/core/types';

// Toasts live a touch longer than the on-map bubble so they're readable over a
// busy video panel, and animate over the whole span.
const TOAST_LIFETIME_MS = REACTION_LIFETIME_MS * 2;

export class ReactionToasts {
  private container: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'reaction-toasts';
    document.body.appendChild(this.container);
  }

  // Show one reaction. `name` is the reacting player's display name; `emoji` is
  // the whitelisted reaction. The toast removes itself when its animation ends.
  show(name: string, emoji: string) {
    const toast = document.createElement('div');
    toast.className = 'reaction-toast';

    const nameEl = document.createElement('span');
    nameEl.className = 'reaction-toast-name';
    nameEl.textContent = name;
    const emojiEl = document.createElement('span');
    emojiEl.className = 'reaction-toast-emoji';
    emojiEl.textContent = emoji;
    toast.append(nameEl, emojiEl);

    this.container.appendChild(toast);

    const anim = toast.animate(
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)', offset: 0.12 },
        { opacity: 1, transform: 'translateY(-10px)', offset: 0.75 },
        { opacity: 0, transform: 'translateY(-28px)' },
      ],
      { duration: TOAST_LIFETIME_MS, easing: 'ease-out' },
    );
    anim.onfinish = () => toast.remove();
    anim.oncancel = () => toast.remove();
  }
}
