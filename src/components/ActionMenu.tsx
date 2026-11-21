import { useEffect, useId, useRef } from "react";

interface Props {
  label: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}

export function ActionMenu({ label, action, onAction, disabled }: Props) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = () => {
      if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
    };
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  return (
    <div className="action-menu">
      <button type="button" className="more-button" aria-label={label} data-hint="更多操作"
        {...{ popovertarget: id }} disabled={disabled}
        onClick={event => {
          const popup = menu.current;
          const panel = event.currentTarget.closest(".panel");
          if (!popup || !panel) return;
          const trigger = event.currentTarget.getBoundingClientRect();
          const above = panel.getBoundingClientRect().bottom - trigger.bottom < 38;
          popup.style.right = `${window.innerWidth - trigger.right}px`;
          popup.style.top = above ? "auto" : `${trigger.bottom + 2}px`;
          popup.style.bottom = above ? `${window.innerHeight - trigger.top + 2}px` : "auto";
        }}>
        <span aria-hidden="true">···</span>
      </button>
      <div ref={menu} id={id} {...{ popover: "auto" }} className="action-popup">
        <button type="button" onClick={() => { menu.current?.hidePopover(); onAction(); }}>{action}</button>
      </div>
    </div>
  );
}
