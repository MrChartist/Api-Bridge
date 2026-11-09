// The dashboard's link to the Bridge, as a small state machine: online, reconnecting, signed out.
//
// - The Bridge restarts (or the network drops) while a page is open: the first failed request puts the page in
//   "reconnecting". A banner says so, and the Bridge's health address is asked again with a growing pause until it
//   answers. Then the banner goes and the page redraws, with no reload by the person.
// - The key this page uses is revoked or expires: the first refused request signs the page out with a clear message
//   (app.js shows the sign-in screen), instead of every poll drawing a broken page.
//
// The state machine is pure (timers and the probe are passed in) so it is tested in Node; the banner is the only DOM.

export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 10_000]);

/**
 * @param {{ probe: () => Promise<boolean>, onChange?: (state: "online" | "reconnecting" | "signedout", prev: string) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (h: unknown) => void, backoff?: readonly number[] }} opts
 */
export function createConnection({ probe, onChange = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), backoff = BACKOFF_MS }) {
  let state = "online";
  let armed = false;
  let timer = null;
  let tries = 0;

  function set(next) {
    if (next === state) return;
    const prev = state;
    state = next;
    onChange(next, prev);
  }
  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    tries = 0;
  }
  function schedule() {
    const wait = backoff[Math.min(tries, backoff.length - 1)];
    tries += 1;
    timer = setTimer(async () => {
      timer = null;
      if (state !== "reconnecting") return;
      let up = false;
      try {
        up = await probe();
      } catch {
        up = false;
      }
      if (state !== "reconnecting") return;
      if (up) {
        stop();
        set("online");
      } else schedule();
    }, wait);
  }

  return {
    /** Start reacting (after sign-in): a refused sign-in attempt must not look like a revoked key. */
    arm() {
      armed = true;
    },
    get state() {
      return state;
    },
    /** A request could not reach the Bridge. */
    networkFailed() {
      if (!armed || state !== "online") return;
      set("reconnecting");
      schedule();
    },
    /** A request was answered by the Bridge (any answer but a refusal of the key): it is back. */
    answered() {
      if (state !== "reconnecting") return;
      stop();
      set("online");
    },
    /** The Bridge refused the key. */
    unauthorized() {
      if (!armed || state === "signedout") return;
      stop();
      set("signedout");
    },
  };
}

// ── The browser part ──

let banner = null;
let hideTimer = null;
function bannerEl() {
  if (banner) return banner;
  banner = document.createElement("div");
  banner.className = "conn-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.hidden = true;
  const dot = document.createElement("span");
  dot.className = "conn-dot";
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "conn-text";
  banner.append(dot, text);
  document.body.append(banner);
  return banner;
}
function showBanner(kind, message) {
  const el = bannerEl();
  clearTimeout(hideTimer);
  el.dataset.kind = kind;
  el.querySelector(".conn-text").textContent = message;
  el.hidden = false;
}
function hideBanner(afterMs = 0) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (banner) banner.hidden = true;
  }, afterMs);
}

/** The shared connection. app.js arms it after sign-in and feeds it the outcome of every request. */
export const connection = createConnection({
  probe: async () => {
    // /v1/health needs no key and costs nothing; any answer at all means the Bridge is back.
    const res = await fetch("/v1/health", { cache: "no-store" });
    return res.status < 500;
  },
  onChange(state, prev) {
    if (typeof document === "undefined") return;
    if (state === "reconnecting") showBanner("wait", "Reconnecting to the Bridge...");
    else if (state === "online" && prev === "reconnecting") {
      showBanner("ok", "Back online");
      hideBanner(2500);
      for (const fn of backListeners) fn();
    } else if (state === "signedout") hideBanner();
    if (state === "signedout") for (const fn of signedOutListeners) fn();
  },
});

const backListeners = new Set();
const signedOutListeners = new Set();
/** Run `fn` when the Bridge is reachable again (the page redraws with fresh data). */
export const onReconnected = (fn) => (backListeners.add(fn), () => backListeners.delete(fn));
/** Run `fn` when the Bridge refused this page's key. */
export const onSignedOut = (fn) => (signedOutListeners.add(fn), () => signedOutListeners.delete(fn));
