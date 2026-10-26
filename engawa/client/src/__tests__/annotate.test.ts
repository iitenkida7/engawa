import { beforeEach, describe, expect, it } from 'bun:test';
import type { AnnotateBody } from '@/core/types';
import { ShareAnnotator } from '@/ui/annotate';

// A 1600x900 share shown in an 800x450 box, so box pixels are exactly half of
// shared-frame pixels and fractions are easy to read off.
function mount() {
  const container = document.createElement('div');
  const body = document.createElement('div');
  const video = document.createElement('video');
  body.appendChild(video);
  container.appendChild(body);
  document.body.appendChild(container);
  Object.defineProperty(body, 'clientWidth', { value: 800 });
  Object.defineProperty(body, 'clientHeight', { value: 450 });
  Object.defineProperty(video, 'videoWidth', { value: 1600 });
  Object.defineProperty(video, 'videoHeight', { value: 900 });
  return { container, body, video };
}

describe('ShareAnnotator', () => {
  let sent: AnnotateBody[];
  let clock: number;
  let annot: ShareAnnotator;
  let container: HTMLElement;
  let canvas: HTMLCanvasElement;

  const button = (tool: 'pointer' | 'pen') =>
    container.querySelector<HTMLButtonElement>(`.annot-btn[data-tool="${tool}"]`);
  const fire = (type: string, x: number, y: number) =>
    canvas.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
    );

  beforeEach(() => {
    // No real 2D context in the test DOM; the annotator just skips drawing.
    const noContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = noContext;
    document.body.innerHTML = '';
    sent = [];
    clock = 1000;
    const m = mount();
    container = m.container;
    annot = new ShareAnnotator({
      container,
      body: m.body,
      video: m.video,
      shareId: 'sharer',
      selfId: () => 'me',
      peer: (id) => ({ name: id, color: '#f00' }),
      send: (b) => sent.push(b),
      now: () => clock,
    });
    canvas = m.body.querySelector('canvas') as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 }) as DOMRect;
  });

  it('sends nothing while no tool is chosen', () => {
    fire('pointerdown', 400, 225);
    fire('pointermove', 410, 230);
    expect(sent).toEqual([]);
  });

  it('the pointer tool sends the position as fractions of the shared frame', () => {
    button('pointer')?.click();
    fire('pointermove', 400, 225);
    expect(sent).toEqual([{ shareId: 'sharer', kind: 'pointer', x: 0.5, y: 0.5 }]);
  });

  it('throttles pointer updates and sends "off" when the pointer leaves', () => {
    button('pointer')?.click();
    fire('pointermove', 100, 100);
    clock += 10;
    fire('pointermove', 110, 110);
    expect(sent).toHaveLength(1);
    clock += 100;
    fire('pointermove', 120, 120);
    expect(sent).toHaveLength(2);
    fire('pointerleave', 0, 0);
    expect(sent[sent.length - 1]).toEqual({ shareId: 'sharer', kind: 'pointer', off: true });
  });

  it('the pen sends a stroke chunk, marked as the end when the button is released', () => {
    button('pen')?.click();
    fire('pointerdown', 0, 0);
    fire('pointermove', 400, 225);
    fire('pointerup', 400, 225);
    const last = sent[sent.length - 1];
    expect(last.kind).toBe('stroke');
    expect(last.end).toBe(true);
    expect(last.pts).toEqual([0, 0, 0.5, 0.5]);
    expect(typeof last.id).toBe('string');
  });

  it('clicking the active tool again turns it off', () => {
    button('pen')?.click();
    button('pen')?.click();
    fire('pointerdown', 10, 10);
    fire('pointerup', 10, 10);
    expect(sent).toEqual([]);
  });

  it('marks received from others are drawn locally and never echoed back', () => {
    annot.receive('peer', { shareId: 'sharer', kind: 'pointer', x: 0.2, y: 0.3 });
    annot.receive('peer', { shareId: 'sharer', kind: 'stroke', id: 's1', pts: [0, 0, 1, 1] });
    annot.receive('peer', { shareId: 'sharer', kind: 'pointer', off: true });
    expect(sent).toEqual([]);
  });

  it('the pen drops points that barely moved', () => {
    button('pen')?.click();
    fire('pointerdown', 400, 225);
    fire('pointermove', 400.5, 225); // < STROKE_MIN_STEP of the frame
    fire('pointermove', 480, 225);
    fire('pointerup', 480, 225);
    expect(sent[sent.length - 1].pts).toEqual([0.5, 0.5, 0.6, 0.5]);
  });
});

describe('ShareAnnotator overlay cost', () => {
  it('holds no backing store until something is drawn', () => {
    const m = mount();
    new ShareAnnotator({
      container: m.container,
      body: m.body,
      video: m.video,
      shareId: 'sharer',
      selfId: () => 'me',
      peer: (id) => ({ name: id, color: '#f00' }),
      send: () => {},
    });
    const canvas = m.body.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });
});
