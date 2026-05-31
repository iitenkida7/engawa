// A lightweight, toggleable chat panel anchored bottom-left. Messages go to the
// sender's current proximity group (the same people they're in a call with), so
// chat stays spatial — distant people don't see it. The server keeps no history
// (stateless invariant), so this panel only holds the most recent messages it
// has seen this session and never backfills. The App owns the network; this
// view owns the DOM and reports sends through the onSend callback.

// How many message rows to keep in the DOM before dropping the oldest.
const MAX_MESSAGES = 40;

export type ChatMessage = {
  from: string;
  name: string;
  text: string;
  isSelf: boolean;
};

export class ChatPanel {
  private panelEl: HTMLDivElement;
  private listEl: HTMLDivElement;
  private inputEl: HTMLInputElement;
  private toggleBtn: HTMLButtonElement;
  private onSend: (text: string) => void;

  private open = false;
  private hasUnread = false;

  constructor(opts: { onSend: (text: string) => void }) {
    this.onSend = opts.onSend;
    this.panelEl = document.getElementById('chat') as HTMLDivElement;
    this.listEl = document.getElementById('chat-list') as HTMLDivElement;
    this.inputEl = document.getElementById('chat-input') as HTMLInputElement;
    this.toggleBtn = document.getElementById('btn-chat') as HTMLButtonElement;
    const form = document.getElementById('chat-form') as HTMLFormElement;

    this.toggleBtn.addEventListener('click', () => this.setOpen(!this.open));
    document.getElementById('chat-close')?.addEventListener('click', () => this.setOpen(false));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.inputEl.value.trim();
      if (!text) return;
      this.inputEl.value = '';
      this.onSend(text);
    });
  }

  private setOpen(open: boolean) {
    this.open = open;
    this.panelEl.classList.toggle('hidden', !open);
    this.toggleBtn.classList.toggle('active', open);
    if (open) {
      this.hasUnread = false;
      this.toggleBtn.classList.remove('has-unread');
      this.inputEl.focus();
      this.scrollToBottom();
    }
  }

  // Render one received (or self-echoed) message and trim the backlog. While the
  // panel is closed, a remote message lights the toolbar button's unread dot.
  addMessage(m: ChatMessage) {
    const row = document.createElement('div');
    row.className = m.isSelf ? 'chat-msg self' : 'chat-msg';

    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = m.name || m.from.slice(0, 6);

    const body = document.createElement('span');
    body.className = 'chat-text';
    // textContent (not innerHTML) so message text is never interpreted as HTML.
    body.textContent = m.text;

    row.append(who, body);
    this.listEl.appendChild(row);
    while (this.listEl.childElementCount > MAX_MESSAGES) {
      this.listEl.firstElementChild?.remove();
    }

    if (this.open) {
      this.scrollToBottom();
    } else if (!m.isSelf) {
      this.hasUnread = true;
      this.toggleBtn.classList.add('has-unread');
    }
  }

  private scrollToBottom() {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}
