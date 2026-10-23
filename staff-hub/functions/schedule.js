// Work-schedule math in office time (Florida). Mirrors web/src/schedule.js.
const TZ = "America/New_York";
const DEFAULT_SCHED = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", pausedUntil: "", off: false };

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
function toUtc(y, m, d, hh, mm) {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 2; i++) { const p = parts(t); t += want - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm); }
  return t;
}
const toMin = (s) => { const [a, b] = String(s || "0:0").split(":").map(Number); return (a || 0) * 60 + (b || 0); };
function dateStr(ts) { const p = parts(ts); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }

function normalize(s) { return Object.assign({}, DEFAULT_SCHED, s || {}); }
function isPaused(s, ts) { s = normalize(s); return !!s.off || (!!s.pausedUntil && s.pausedUntil >= dateStr(ts)); }
function onShift(s, ts) {
  s = normalize(s);
  if (isPaused(s, ts)) return false;
  const p = parts(ts), mins = p.hh * 60 + p.mm;
  return s.days.includes(p.wd) && mins >= toMin(s.start) && mins < toMin(s.end);
}
function nextShift(s, ts) {
  s = normalize(s);
  const p = parts(ts), start = toMin(s.start);
  for (let i = 0; i < 15; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    const t = toUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(start / 60), start % 60);
    if (t > ts && !isPaused(s, t)) return t;
  }
  return null;
}
function clean(s) {
  s = normalize(s);
  const time = (v, d) => (/^\d{2}:\d{2}$/.test(v) ? v : d);
  return {
    days: [...new Set((s.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort(),
    start: time(s.start, "08:00"), end: time(s.end, "17:00"),
    pausedUntil: /^\d{4}-\d{2}-\d{2}$/.test(s.pausedUntil || "") ? s.pausedUntil : "",
    off: !!s.off,
  };
}

module.exports = { TZ, DEFAULT_SCHED, onShift, nextShift, isPaused, clean };
