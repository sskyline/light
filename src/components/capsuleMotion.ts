import type { Transition } from "framer-motion";

export const capsuleLayout: Transition = { type: "tween", duration: 0.28, ease: "easeInOut" };

export function collapseTransition(reduced: boolean | null): Transition {
  return reduced
    ? { duration: 0 }
    : {
        height: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.16, ease: "easeOut" },
      };
}

// Both the idle mark and the agent text use the same handoff in either direction.
export function capsuleContent(reduced: boolean | null) {
  const fade = { duration: reduced ? 0 : 0.14, ease: "easeInOut" } as const;
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { ...fade, delay: reduced ? 0 : 0.10 } },
    exit: { opacity: 0, transition: fade },
  };
}
