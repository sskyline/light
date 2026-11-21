import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function hintTarget(node: EventTarget | null) {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>(".panel [data-hint]");
  if (target instanceof HTMLButtonElement && target.popoverTargetElement?.matches(":popover-open")) return null;
  if (target?.hasAttribute("data-truncated-only") && target.scrollWidth <= target.clientWidth) return null;
  return target ?? null;
}

export function HoverHint({ over }: { over: boolean }) {
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pointer = (event: PointerEvent) => setHovered(hintTarget(event.type === "pointerout" ? event.relatedTarget : event.target));
    const focus = (event: FocusEvent) => {
      const node = event.target;
      setFocused(node instanceof Element && node.matches(":focus-visible") ? hintTarget(node) : null);
    };
    const blur = () => setFocused(null);
    const dismiss = () => { setHovered(null); setFocused(null); };
    document.addEventListener("pointerover", pointer);
    document.addEventListener("pointerout", pointer);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerover", pointer);
      document.removeEventListener("pointerout", pointer);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  // Click-through windows can stop receiving DOM pointer events on exit.
  useEffect(() => { if (!over) setHovered(null); }, [over]);
  const anchor = hovered?.isConnected ? hovered : focused?.isConnected ? focused : null;
  const text = anchor?.dataset.hint;

  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !anchor) return;
    const place = () => {
      const bounds = anchor.closest(".panel")?.getBoundingClientRect();
      if (!bounds) return;
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(4, bounds.left + 4);
      const right = Math.min(innerWidth - 4, bounds.right - 4);
      el.style.maxWidth = Math.min(350, right - left) + "px";
      const size = el.getBoundingClientRect();
      const before = rect.left - size.width - 6;
      const after = rect.right + 6;
      let x = before;
      let y = rect.top + (rect.height - size.height) / 2;
      if (before < left) {
        if (after + size.width <= right) x = after;
        else {
          x = rect.left + (rect.width - size.width) / 2;
          y = rect.bottom + size.height + 4 <= bounds.bottom ? rect.bottom + 3 : rect.top - size.height - 3;
        }
      }
      el.style.left = Math.max(left, Math.min(x, right - size.width)) + "px";
      el.style.top = Math.max(4, bounds.top, Math.min(y, bounds.bottom - size.height)) + "px";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor, text]);

  return anchor && text ? createPortal(<div ref={tip} className="hover-hint" role="tooltip">{text}</div>, document.body) : null;
}
