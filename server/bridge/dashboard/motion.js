// Animation helpers for the dashboard, built on Motion (window.Motion, vendored motion.min.js v14.1.0).
// Every helper is a no-op when Motion is missing or the visitor prefers reduced motion.
export const Motion = typeof window !== "undefined" ? window.Motion ?? null : null;
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
