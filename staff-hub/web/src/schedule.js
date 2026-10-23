// Work-schedule math in office time (Florida). Mirrors functions/schedule.js.
export const TZ = "America/New_York";
export const DEFAULT_SCHED = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", pausedUntil: "", off: false };
export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function parts(ts) {
  const o = {};
  fmt.formatToParts(new Date(ts)).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, hh: (+o.hour) % 24, mm: +o.minute, wd: WEEKDAYS.indexOf(o.weekday) };
}
export const toMin = (s) => { const [a, b] = String(s || "0:0").split(":").map(Number); return (a || 0) * 60 + (b || 0); };
export function todayStr(ts = Date.now()) { const p = parts(ts); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }
export const normalize = (s) => Object.assign({}, DEFAULT_SCHED, s || {});
export function isPaused(s, ts = Date.now()) { s = normalize(s); return !!s.off || (!!s.pausedUntil && s.pausedUntil >= todayStr(ts)); }
export function onShift(s, ts = Date.now()) {
  s = normalize(s);
  if (isPaused(s, ts)) return false;
  const p = parts(ts), mins = p.hh * 60 + p.mm;
  return s.days.includes(p.wd) && mins >= toMin(s.start) && mins < toMin(s.end);
}
function fmt12(t) { const m = toMin(t), h = Math.floor(m / 60), mm = m % 60; return ((h + 11) % 12 + 1) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (h < 12 ? " AM" : " PM"); }
export function schedText(s) {
  s = normalize(s);
  if (s.off) return "Notifications off";
  const days = s.days.slice().sort().join();
  const d = days === "0,1,2,3,4,5,6" ? "Every day" : days === "1,2,3,4,5" ? "Mon–Fri" : days === "1,2,3,4,5,6" ? "Mon–Sat"
    : s.days.slice().sort().map((x) => DAY_NAMES[x].slice(0, 3)).join(", ") || "No days";
  return `${d}, ${fmt12(s.start)}–${fmt12(s.end)}` + (s.pausedUntil && s.pausedUntil >= todayStr() ? ` · paused through ${s.pausedUntil}` : "");
}
