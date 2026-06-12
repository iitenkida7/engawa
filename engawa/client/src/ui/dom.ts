// Tiny DOM-creation helper: createElement plus the handful of properties the
// UI layer sets everywhere (class, text, title, dataset, click handler) and
// ordered children. Anything beyond these props (video.autoplay,
// input.maxLength, canvas.width, …) is assigned on the returned element by the
// caller — this is sugar over createElement, not a framework (invariant #5).
type ElProps = {
  className?: string;
  textContent?: string;
  title?: string;
  dataset?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className !== undefined) node.className = props.className;
  if (props.textContent !== undefined) node.textContent = props.textContent;
  if (props.title !== undefined) node.title = props.title;
  if (props.dataset) Object.assign(node.dataset, props.dataset);
  // Widen to HTMLElement so the 'click' overload (MouseEvent listener) resolves
  // despite the generic element type.
  if (props.onClick) (node as HTMLElement).addEventListener('click', props.onClick);
  node.append(...children);
  return node;
}
