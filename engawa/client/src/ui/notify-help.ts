import { t } from '@/core/i18n';
import { detectOs, type HostOs } from '@/ui/desktop-notify';

// Fix-it guide shown when turning desktop notifications on fails. There are two
// gates: the browser's site permission (detectable — 'denied') and the OS letting
// the browser show notifications (not observable from the page, so we land here
// when the user says the test notification never arrived).
export type NotifyGate = 'browser' | 'os';

// URL schemes that open the OS notification settings. Browsers ask before
// handing them to the OS; chrome:// pages can't be linked from a page at all,
// which is why the browser gate gets written steps only.
const SETTINGS_URL: Partial<Record<HostOs, string>> = {
  mac: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  windows: 'ms-settings:notifications',
};

const OS_STEPS: Record<HostOs, string[]> = {
  mac: ['notify.help.mac1', 'notify.help.mac2', 'notify.help.mac3'],
  windows: ['notify.help.win1', 'notify.help.win2', 'notify.help.win3'],
  other: ['notify.help.other1', 'notify.help.other2'],
};
const BROWSER_STEPS = ['notify.help.browser1', 'notify.help.browser2', 'notify.help.browser3'];

export class NotifyHelpPanel {
  private panel = document.getElementById('notify-help') as HTMLDivElement;

  constructor(private onRetest: () => void) {
    document
      .getElementById('notify-help-close')
      ?.addEventListener('click', () => this.panel.classList.add('hidden'));
  }

  show(gate: NotifyGate) {
    const os = detectOs(navigator.userAgent);
    const title = document.getElementById('notify-help-title') as HTMLElement;
    const lead = document.getElementById('notify-help-lead') as HTMLElement;
    const steps = document.getElementById('notify-help-steps') as HTMLOListElement;
    const actions = document.getElementById('notify-help-actions') as HTMLDivElement;

    title.textContent = t(gate === 'browser' ? 'notify.help.browserTitle' : 'notify.help.osTitle');
    lead.textContent = t(gate === 'browser' ? 'notify.help.browserLead' : 'notify.help.osLead');
    steps.replaceChildren();
    for (const key of gate === 'browser' ? BROWSER_STEPS : OS_STEPS[os]) {
      const li = document.createElement('li');
      li.textContent = t(key);
      steps.appendChild(li);
    }

    actions.replaceChildren();
    const url = SETTINGS_URL[os];
    if (gate === 'os' && url) {
      const open = document.createElement('a');
      open.className = 'notify-help-btn primary';
      open.href = url;
      open.textContent = t('notify.help.openSettings');
      actions.appendChild(open);
    }
    if (gate === 'os') {
      const retest = document.createElement('button');
      retest.className = 'notify-help-btn';
      retest.textContent = t('notify.help.retest');
      retest.addEventListener('click', () => {
        this.panel.classList.add('hidden');
        this.onRetest();
      });
      actions.appendChild(retest);
    }
    this.panel.classList.remove('hidden');
  }
}
