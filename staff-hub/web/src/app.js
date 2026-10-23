// Enchanted Staff Hub: the app staff use on their phones and computers.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  connectFirestoreEmulator, collection, doc, query, where, orderBy, limit, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, deleteField,
} from "firebase/firestore";
import { getStorage, connectStorageEmulator, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { getMessaging, getToken, isSupported as messagingSupported } from "firebase/messaging";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { DEFAULT_SCHED, DAY_LETTERS, DAY_NAMES, normalize, onShift, isPaused, schedText, toMin } from "./schedule.js";

const VAPID_KEY = __VAPID_KEY__;
const REACTS = [["like", "👍"], ["heart", "❤️"], ["laugh", "😂"], ["wow", "😮"], ["party", "🎉"], ["pray", "🙏"]];
const $ = (id) => document.getElementById(id);

let fb, auth, db, storage, fns;
const call = (name, data) => httpsCallable(fns, name)(data || {}).then((r) => r.data);

const S = {
  uid: null, me: null, users: {}, unsubs: [], groupKey: "",
  communities: {}, channels: {}, posts: {}, loaded: new Set(),
  threads: {}, threadUnsubs: {}, lastSeen: {},
  view: null, query: "", open: new Set(), picking: null, editing: null, confirm: null,
  drafts: {}, maps: { compose: {} }, composing: false, pending: [], busy: false,
  flash: null, showNotYet: new Set(), mail: null, tab: "posts",
};

// ---------- small helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
let toastTimer;
function toast(msg, ms) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3600);
}
function oops(e, fallback) {
  console.error(e);
  const code = (e && e.code) || "";
  if (code.includes("permission-denied")) toast("You don't have permission to do that.");
  else if (code.includes("unavailable")) toast("You're offline. It will save when you reconnect.");
  else if (code.startsWith("functions/") && e.message) toast(e.message);
  else toast(fallback || "That didn't work. Try again.");
}
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(ts) {
  const d = new Date(ts), now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, y)) return "Yesterday";
  const o = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString([], o);
}
const when = (ts) => { const l = dayLabel(ts); return l === "Today" ? timeOf(ts) : `${l}, ${timeOf(ts)}`; };
const isAdmin = () => !!S.me && S.me.role === "admin";
const myGroups = () => (isAdmin() ? ["all", "providers"] : ["all", ...((S.me && S.me.groups) || [])]);
const user = (id) => S.users[id] || { name: "Former staff member" };
const nameOf = (id) => (id === S.uid ? "You" : user(id).name || "Team member");
function hue(id) { let x = 0; for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; }
function avatar(id, sm) {
  const n = user(id).name || "?";
  const ini = n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return h("span", { class: "initials" + (sm ? " sm" : ""), style: `background:hsl(${hue(id)} 35% 42%)`, title: n, "aria-hidden": "true", text: ini });
}

// ---------- data access ----------
const communities = () => Object.values(S.communities).sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt);
const comm = (id) => S.communities[id];
const chan = (id) => S.channels[id];
const channelsOf = (cid) => Object.values(S.channels).filter((c) => c.communityId === cid)
  .sort((a, b) => (b.general ? 1 : 0) - (a.general ? 1 : 0) || (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt);
const generalOf = (cid) => channelsOf(cid).find((c) => c.general) || channelsOf(cid)[0];
const liveChannel = (id) => { const c = chan(id); return c && comm(c.communityId) ? c : null; };
const allPosts = () => Object.values(S.posts);
const acked = (p, uid = S.uid) => !!(p.acks && p.acks[uid]);
const canPostIn = (ch) => !!ch && S.me && S.me.active && (ch.postPolicy !== "admins" || isAdmin());
const canModify = (d) => isAdmin() || d.author === S.uid;
const activeUsers = () => Object.entries(S.users).filter(([, u]) => u.active).map(([id, u]) => Object.assign({ id }, u));
const inGroup = (u, g) => g === "all" || u.role === "admin" || (u.groups || []).includes(g);
const audience = (p) => activeUsers().filter((u) => u.id !== p.author && inGroup(u, p.group || "all"));

function needsAck() {
  return allPosts().filter((p) => p.priority !== "update" && p.author !== S.uid && !acked(p) && liveChannel(p.channelId));
}
function mentionsOfMe() {
  return allPosts().filter((p) => (p.mentions || []).includes(S.uid) && p.author !== S.uid && liveChannel(p.channelId))
    .sort((a, b) => b.createdAt - a.createdAt);
}
const unreadMentions = () => { const since = S.lastSeen.activity || 0; return mentionsOfMe().filter((p) => p.createdAt > since).length; };
function unreadCount(chId) {
  const since = S.lastSeen[chId] || 0;
  return allPosts().filter((p) => p.channelId === chId && p.createdAt > since && p.author !== S.uid).length;
}
let seenTimer = null, seenPending = {};
function markSeen(key, ts) {
  if (!key || !ts || (S.lastSeen[key] || 0) >= ts) return;
  S.lastSeen[key] = ts; seenPending[key] = ts;
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => {
    const upd = seenPending; seenPending = {};
    setDoc(doc(db, `users/${S.uid}/private/state`), { lastSeen: upd }, { merge: true }).catch(() => {});
  }, 1500);
}

// ---------- files and links ----------
const EXT_MIME = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv", txt: "text/plain", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
};
const mimeFor = (f) => EXT_MIME[(f.name.split(".").pop() || "").toLowerCase()] || f.type || "";
const KINDS = {
  pdf: ["PDF", "PDF"], word: ["W", "Word document"], excel: ["X", "Excel spreadsheet"], ppt: ["P", "PowerPoint"], image: ["IMG", "Photo"], text: ["TXT", "Text file"],
  gdoc: ["Docs", "Google Doc"], gsheet: ["Sheets", "Google Sheet"], gslide: ["Slides", "Google Slides"], gform: ["Forms", "Google Form"],
  gfolder: ["Folder", "Drive folder"], gdrive: ["Drive", "Google Drive file"], link: ["Link", "Link"], file: ["File", "File"],
};
function kindOfType(type) {
  if (!type) return "file";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (/word/.test(type)) return "word";
  if (/sheet|excel|csv/.test(type)) return "excel";
  if (/presentation|powerpoint/.test(type)) return "ppt";
  if (type === "text/plain") return "text";
  return "file";
}
function kindOfUrl(url) {
  if (/docs\.google\.com\/document/.test(url)) return "gdoc";
  if (/docs\.google\.com\/spreadsheets/.test(url)) return "gsheet";
  if (/docs\.google\.com\/presentation/.test(url)) return "gslide";
  if (/docs\.google\.com\/forms|forms\.gle\//.test(url)) return "gform";
  if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders/.test(url)) return "gfolder";
  if (/drive\.google\.com\//.test(url)) return "gdrive";
  return "link";
}
const badge = (kind) => h("span", { class: "ft ft-" + kind, "aria-hidden": "true", text: KINDS[kind][0] });
function linkNode(url, label) {
  const kind = kindOfUrl(url);
  if (kind === "link") return h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: label || url });
  return h("a", { class: "drive-chip", href: url, target: "_blank", rel: "noopener noreferrer", title: KINDS[kind][1] }, badge(kind), h("span", { text: label || KINDS[kind][1] }));
}
// Every file and link in a post, for the Files tab.
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
function filesIn(p) {
  const out = (p.attachments || []).map((a) => ({ url: a.url, name: a.name || "File", kind: kindOfType(a.type), post: p }));
  String(p.body || "").replace(LINK_RE, (m, label, named, bare) => {
    const url = named || bare;
    out.push({ url, name: label || (kindOfUrl(url) === "link" ? url.replace(/^https?:\/\//, "").slice(0, 60) : KINDS[kindOfUrl(url)][1]), kind: kindOfUrl(url), post: p });
    return m;
  });
  return out;
}

// ---------- rich text ----------
const INLINE = /\*\*([^*\n]+)\*\*|<@([A-Za-z0-9_\-]+)>|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\(?\b\d{3}\)?[\s.-]?\d{3}[-.\s]\d{4}\b)/g;
function inline(s) {
  const out = []; let last = 0;
  s.replace(INLINE, (m, b, mid, label, named, url, ph, idx) => {
    if (idx > last) out.push(s.slice(last, idx));
    if (b != null) out.push(h("strong", null, inline(b)));
    else if (mid) out.push(h("span", { class: "mention" + (mid === S.uid ? " self" : ""), text: "@" + (mid === S.uid ? (S.me.name || "You") : nameOf(mid)) }));
    else if (named) out.push(linkNode(named, label));
    else if (url) out.push(linkNode(url));
    else out.push(h("a", { class: "phone", href: "tel:" + m.replace(/[^\d+]/g, ""), text: m }));
    last = idx + m.length; return m;
  });
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function richText(text) {
  const frag = document.createDocumentFragment(); let list = null;
  for (const line of (text || "").split("\n")) {
    let m;
    if ((m = line.match(/^\s*[-•*]\s+(.*)$/))) {
      if (!list) { list = h("ul", { class: "rt-list" }); frag.append(list); }
      list.append(h("li", null, inline(m[1]))); continue;
    }
    list = null;
    if ((m = line.match(/^#{1,3}\s+(.*)$/))) frag.append(h("div", { class: "rt-h" }, inline(m[1])));
    else if (!line.trim()) frag.append(h("div", { class: "rt-gap" }));
    else frag.append(h("div", { class: "rt-p" }, inline(line)));
  }
  return frag;
}
const plainText = (text) => (text || "").replace(/<@([^>]+)>/g, (m, id) => "@" + nameOf(id)).replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
function encodeMentions(text, map) {
  let out = text; const ids = new Set();
  Object.keys(map || {}).sort((a, b) => b.length - a.length).forEach((name) => {
    const tok = "@" + name;
    if (out.includes(tok)) { out = out.split(tok).join(`<@${map[name]}>`); ids.add(map[name]); }
  });
  return { text: out, mentions: [...ids] };
}
function decodeMentions(text, key) {
  const map = S.maps[key] = S.maps[key] || {};
  return (text || "").replace(/<@([^>]+)>/g, (m, id) => { const n = user(id).name || "Someone"; map[n] = id; return "@" + n; });
}

// ---------- mention picker ----------
let pick = null;
function onMentionInput(ta, key) {
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/(^|\s)@([A-Za-z][A-Za-z .'\-]{0,30})?$/);
  if (!m) { closePick(); return; }
  const q = (m[2] || "").toLowerCase();
  const hits = activeUsers().filter((u) => u.id !== S.uid && (u.name || "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
  pick = { ta, key, start: ta.selectionStart - (m[2] || "").length - 1, hits, sel: 0 };
  drawPick();
}
function drawPick() {
  const pop = $("mentionPop");
  if (!pick) { pop.hidden = true; return; }
  const r = pick.ta.getBoundingClientRect();
  pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - 260)) + "px";
  pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 220) + "px";
  pop.replaceChildren(...(pick.hits.length ? pick.hits.map((u, i) => h("button", {
    type: "button", class: i === pick.sel ? "sel" : "", role: "option",
    onmousedown: (e) => { e.preventDefault(); choosePick(u); },
  }, avatar(u.id, true), h("span", { text: u.name }))) : [h("div", { class: "none", text: "No one matches that name" })]));
  pop.hidden = false;
}
function choosePick(u) {
  const { ta, key, start } = pick;
  const ins = "@" + u.name + " ";
  ta.value = ta.value.slice(0, start) + ins + ta.value.slice(ta.selectionStart);
  const pos = start + ins.length; ta.setSelectionRange(pos, pos);
  (S.maps[key] = S.maps[key] || {})[u.name] = u.id;
  if (key !== "compose") S.drafts[key] = ta.value;
  closePick(); ta.focus();
}
function closePick() { pick = null; $("mentionPop").hidden = true; }
function wireMentions(ta, key) {
  ta.addEventListener("input", () => onMentionInput(ta, key));
  ta.addEventListener("keydown", (e) => {
    if (!pick || !pick.hits.length) return;
    if (e.key === "ArrowDown") pick.sel = (pick.sel + 1) % pick.hits.length;
    else if (e.key === "ArrowUp") pick.sel = (pick.sel - 1 + pick.hits.length) % pick.hits.length;
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choosePick(pick.hits[pick.sel]); return; }
    else if (e.key === "Escape") { closePick(); return; }
    else return;
    e.preventDefault(); drawPick();
  }, true);
  ta.addEventListener("blur", () => setTimeout(() => { if (pick && pick.ta === ta) closePick(); }, 150));
}

// ---------- render ----------
let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
const SPECIAL = ["activity", "team", "me"];

function render() {
  if (!S.me) return;
  const ready = S.loaded.has("communities:all") && S.loaded.has("channels:all");
  if (ready) {
    if (!S.view) S.view = (needsAck().length || unreadMentions()) ? "activity" : ((communities()[0] && generalOf(communities()[0].id)) || {}).id || "activity";
    if (!SPECIAL.includes(S.view) && !liveChannel(S.view)) S.view = "activity";
  }
  const active = document.activeElement;
  const activeId = active && active.id && active.closest && active.closest("#feed") ? active.id : null;
  const sel = activeId ? [active.selectionStart, active.selectionEnd] : null;

  renderSide(); renderHead(); renderFeed();

  if (activeId && $(activeId)) { const el = $(activeId); el.focus(); try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
  if (S.flash) {
    const el = document.querySelector(`[data-post="${S.flash}"]`);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); const id = S.flash; S.flash = null; setTimeout(() => { const e2 = document.querySelector(`[data-post="${id}"]`); if (e2) e2.classList.remove("flash"); }, 2500); }
  }
}

function renderSide() {
  const badge = needsAck().length + (S.view === "activity" ? 0 : unreadMentions());
  const ac = $("activityCount"); ac.hidden = !badge; ac.textContent = badge > 99 ? "99+" : badge;
  $("activityBtn").setAttribute("aria-current", S.view === "activity" ? "true" : "false");
  $("addCommBtn").hidden = !isAdmin();

  const list = $("commList"); list.replaceChildren();
  for (const c of communities()) {
    const chs = channelsOf(c.id), gen = chs.find((x) => x.general);
    const box = h("div", { class: "comm" });
    const gUnread = gen && gen.id !== S.view ? unreadCount(gen.id) : 0;
    box.append(h("button", {
      class: "nav-item comm-head" + (gUnread ? " unread" : ""), type: "button", "aria-current": gen && gen.id === S.view ? "true" : "false",
      onclick: () => gen && go(gen.id),
    }, h("span", { class: "tile", "aria-hidden": "true", text: c.icon || "✦" }),
      h("span", { class: "label" }, c.name, c.group !== "all" ? h("span", { class: "lock", text: "🔒 Providers & managers" }) : null),
      gUnread ? h("span", { class: "count", text: gUnread > 99 ? "99+" : String(gUnread) }) : null));
    for (const ch of chs) {
      if (ch.general) continue;
      const n = ch.id === S.view ? 0 : unreadCount(ch.id);
      box.append(h("button", {
        class: "nav-item chan-row" + (n ? " unread" : ""), type: "button", "aria-current": ch.id === S.view ? "true" : "false", onclick: () => go(ch.id),
      }, h("span", { class: "emo", "aria-hidden": "true", text: ch.icon || "#" }), h("span", { class: "label", text: ch.name }),
        n ? h("span", { class: "count", text: n > 99 ? "99+" : String(n) }) : null));
    }
    if (isAdmin()) box.append(h("button", { class: "nav-item add-chan", type: "button", onclick: () => channelModal(c) },
      h("span", { class: "emo", "aria-hidden": "true", text: "+" }), h("span", { class: "label", text: "Add channel" })));
    list.append(box);
  }

  $("meBox").replaceChildren(avatar(S.uid),
    h("div", { class: "grow" }, h("span", { text: S.me.name || "You" }), h("span", { class: "role", text: isAdmin() ? "Manager" : (S.me.title || "Team member") })),
    h("button", { class: "icon-btn", type: "button", title: "My settings", "aria-label": "My settings and notifications", onclick: () => go("me") }, "⚙"),
    isAdmin() ? h("button", { class: "icon-btn", type: "button", title: "Team", "aria-label": "Manage staff", onclick: () => go("team") }, "👥") : null);
}

function renderHead() {
  const tools = $("chActions"); tools.replaceChildren();
  const set = (tile, eyebrow, title, topic) => { $("chTile").textContent = tile; $("chEyebrow").textContent = eyebrow; $("chTitle").textContent = title; $("chTopic").textContent = topic; };
  $("search").hidden = SPECIAL.includes(S.view);
  $("search").placeholder = S.tab === "files" ? "Search files" : "Search this channel";
  if (S.view === "activity") return set("🔔", "", "Activity", "Posts that need your acknowledgement and places you were mentioned.");
  if (S.view === "me") return set("⚙", "", "My settings", "Notifications, your work schedule and your account.");
  if (S.view === "team") return set("👥", "Managers", "Team", "Invite staff, set roles and work schedules.");
  const ch = chan(S.view), c = ch && comm(ch.communityId);
  if (!ch || !c) return set("✦", "", "Staff Hub", "");
  if (ch.general) set(c.icon || "✦", c.group !== "all" ? "Private community" : "Community", c.name, c.topic || "");
  else set(ch.icon || "#", c.name, ch.name, ch.topic || "");
  const nFiles = new Set(allPosts().filter((p) => p.channelId === ch.id).flatMap((p) => filesIn(p).map((f) => f.url))).size;
  tools.append(h("span", { class: "tabs", role: "tablist" },
    h("button", { type: "button", role: "tab", "aria-selected": S.tab === "posts" ? "true" : "false", onclick: () => { S.tab = "posts"; schedule(); } }, "Posts"),
    h("button", { type: "button", role: "tab", "aria-selected": S.tab === "files" ? "true" : "false", onclick: () => { S.tab = "files"; schedule(); } }, `Files${nFiles ? ` (${nFiles})` : ""}`)));
  if (isAdmin()) {
    const key = "del:" + ch.id, what = ch.general ? "community" : "channel";
    if (S.confirm === key) {
      tools.append(h("span", { class: "confirm" }, ch.general ? "Delete this community, its channels and every post?" : "Delete this channel and all its posts?",
        h("button", { class: "btn danger solid sm", type: "button", onclick: () => removeChannelOrCommunity(ch, c) }, "Delete"),
        h("button", { class: "btn sm", type: "button", onclick: () => { S.confirm = null; schedule(); } }, "Cancel")));
    } else {
      tools.append(h("button", { class: "btn sm", type: "button", onclick: () => (ch.general ? communityModal(c) : channelModal(c, ch)) }, "Edit " + what));
      tools.append(h("button", { class: "btn sm danger", type: "button", onclick: () => { S.confirm = key; schedule(); } }, "Delete " + what));
    }
  }
}

function renderFeed() {
  const feed = $("feed");
  const ch = SPECIAL.includes(S.view) ? null : chan(S.view);
  const postable = canPostIn(ch) && S.tab === "posts";
  $("newPostBtn").hidden = !postable || S.composing;
  $("composer").hidden = !(postable && S.composing);
  $("breakWrap").hidden = !$("pri-urgent").checked;
  renderPending();
  renderPushNudge();

  const out = [];
  if (S.view === "me") { feed.replaceChildren(settingsPanel()); return; }
  if (S.view === "team") { feed.replaceChildren(isAdmin() ? teamPanel() : h("div", { class: "notice", text: "Only managers can manage staff." })); return; }
  if (!S.loaded.has("communities:all") || !S.loaded.has("posts:all")) { feed.replaceChildren(h("div", { class: "empty" }, h("h2", { text: "Loading updates" }))); return; }

  if (!communities().length) {
    out.push(h("div", { class: "empty" }, h("h2", { text: "No communities yet" }),
      h("p", { text: isAdmin() ? "Load your Enchanted communities and channels to get started, or create your own with the + button." : "Your manager hasn't set up any communities yet." }),
      isAdmin() ? h("button", { class: "btn gold", type: "button", onclick: seed }, "Load our communities") : null));
    feed.replaceChildren(...out); return;
  }

  if (S.view === "activity") {
    const acks = needsAck().sort((a, b) => b.createdAt - a.createdAt);
    const ments = mentionsOfMe().slice(0, 40);
    out.push(h("div", { class: "section-label", text: "Needs your acknowledgement" }));
    if (!acks.length) out.push(h("div", { class: "notice", text: "You're all caught up. Every important and urgent post has your acknowledgement." }));
    acks.forEach((p) => out.push(postNode(p, { showWhere: true })));
    out.push(h("div", { class: "section-label", text: "Mentions" }));
    const shown = new Set(acks.map((p) => p.id));
    const rest = ments.filter((p) => !shown.has(p.id));
    if (!rest.length) out.push(h("div", { class: "notice", text: "When someone @mentions you in a post, it shows up here." }));
    rest.forEach((p) => out.push(postNode(p, { showWhere: true })));
    if (ments.length) markSeen("activity", ments[0].createdAt);
    feed.replaceChildren(...out); return;
  }

  if (S.tab === "files" && ch) { feed.replaceChildren(...filesPanel(ch)); return; }
  const q = S.query.trim().toLowerCase();
  let posts = allPosts().filter((p) => p.channelId === S.view);
  if (posts.length) markSeen(S.view, Math.max(...posts.map((p) => p.createdAt)));
  if (q) posts = posts.filter((p) => `${p.subject || ""} ${plainText(p.body)}`.toLowerCase().includes(q));
  posts.sort((a, b) => b.createdAt - a.createdAt);
  const pinned = q ? [] : posts.filter((p) => p.pinned);
  const rest = q ? posts : posts.filter((p) => !p.pinned);
  if (ch && ch.postPolicy === "admins" && !isAdmin()) out.push(h("div", { class: "notice", text: "Only managers post in this channel. You can still react, reply and acknowledge." }));
  if (pinned.length) { out.push(h("div", { class: "section-label", text: "Pinned" })); pinned.forEach((p) => out.push(postNode(p, {}))); }
  let lastDay = null;
  for (const p of rest) {
    const d = dayLabel(p.createdAt);
    if (d !== lastDay) { out.push(h("div", { class: "day", text: d })); lastDay = d; }
    out.push(postNode(p, {}));
  }
  if (!posts.length) out.push(h("div", { class: "empty" }, h("h2", { text: q ? "No matching posts" : "No posts yet" }),
    h("p", { text: q ? "Try a different word." : postable ? "Start the conversation with New post. Mark it Important or Urgent when everyone needs to confirm they've read it." : "Posts here will show up for everyone in this community." })));
  feed.replaceChildren(...out);
}

function renderPending() {
  $("cFiles").replaceChildren(...S.pending.map((f) => h("span", { class: "pending-item" },
    badge(kindOfType(f.type)), h("span", { text: f.uploading ? `Uploading ${f.name}…` : f.name }),
    f.uploading ? null : h("button", { class: "link-btn", type: "button", "aria-label": "Remove " + f.name, onclick: () => { S.pending = S.pending.filter((x) => x !== f); renderPending(); } }, "✕"))));
}

function attNodes(list) {
  if (!list || !list.length) return null;
  return h("div", { class: "atts" }, list.map((a) => (a.type || "").startsWith("image/")
    ? h("a", { href: a.url, target: "_blank", rel: "noopener" }, h("img", { class: "att-img", src: a.url, alt: a.name || "Photo", loading: "lazy" }))
    : h("a", { class: "att-file", href: a.url, target: "_blank", rel: "noopener" }, badge(kindOfType(a.type)), h("span", { text: a.name || "File" }))));
}

function postNode(p, opt) {
  const pr = p.priority || "update";
  const ackIds = Object.keys(p.acks || {}).sort((a, b) => p.acks[a] - p.acks[b]);
  const isOpen = S.open.has(p.id);
  const ch = chan(p.channelId), c = ch && comm(ch.communityId);

  const actions = h("div", { class: "post-actions" });
  if (isAdmin() && !opt.showWhere) actions.append(h("button", { class: "link-btn", type: "button", onclick: () => updatePost(p, { pinned: !p.pinned }) }, p.pinned ? "Unpin" : "Pin"));
  if (p.author === S.uid) actions.append(h("button", { class: "link-btn", type: "button", onclick: () => { S.editing = p.id; S.maps["edit-" + p.id] = {}; delete S.drafts["edit-" + p.id]; delete S.drafts["edit-s-" + p.id]; schedule(); } }, "Edit"));
  if (canModify(p)) actions.append(h("button", { class: "link-btn", type: "button", onclick: () => { S.confirm = "post:" + p.id; schedule(); } }, "Delete"));

  const meta = h("div", { class: "post-meta" },
    h("span", { class: "author", text: nameOf(p.author) }),
    h("span", { class: "time", text: when(p.createdAt), title: new Date(p.createdAt).toLocaleString() }),
    opt.showWhere && ch && c ? h("span", { class: "where" }, "in ", h("button", { type: "button", onclick: () => go(ch.id), text: ch.general ? c.name : `${c.name} › ${ch.name}` })) : null,
    pr !== "update" ? h("span", { class: "chip " + pr, text: pr }) : null,
    p.pinned ? h("span", { class: "chip pin", text: "Pinned" }) : null);

  const node = h("article", { class: `post pr-${pr}` + ((p.mentions || []).includes(S.uid) ? " mentions-me" : ""), "data-post": p.id },
    h("div", { class: "post-head" }, avatar(p.author), meta, actions));

  if (S.confirm === "post:" + p.id) node.append(h("div", { class: "confirm" }, "Delete this post and its replies?",
    h("button", { class: "btn danger solid sm", type: "button", onclick: () => { S.confirm = null; deleteDoc(doc(db, "posts", p.id)).then(() => toast("Post deleted")).catch(oops); } }, "Delete"),
    h("button", { class: "btn sm", type: "button", onclick: () => { S.confirm = null; schedule(); } }, "Cancel")));

  if (S.editing === p.id) {
    const sid = "edit-s-" + p.id, tid = "edit-" + p.id;
    const si = h("input", { id: sid, "aria-label": "Subject", placeholder: "Subject", oninput: (e) => { S.drafts[sid] = e.target.value; } });
    si.value = S.drafts[sid] != null ? S.drafts[sid] : (p.subject || "");
    const ta = h("textarea", { id: tid, "aria-label": "Edit post", oninput: (e) => { S.drafts[tid] = e.target.value; } });
    ta.value = S.drafts[tid] != null ? S.drafts[tid] : decodeMentions(p.body, tid);
    wireMentions(ta, tid);
    node.append(h("div", { class: "edit-box" }, si, ta, h("div", { class: "row" },
      h("button", { class: "btn primary sm", type: "button", onclick: () => saveEdit(p) }, "Save"),
      h("button", { class: "btn sm", type: "button", onclick: () => { S.editing = null; schedule(); } }, "Cancel"))));
  } else {
    if (p.subject) node.append(h("div", { class: "post-subject", text: p.subject }));
    if (p.body) node.append(h("div", { class: "post-body" }, richText(p.body)));
    const atts = attNodes(p.attachments); if (atts) node.append(atts);
    if (p.editedAt) node.append(h("span", { class: "edited", text: "Edited " + when(p.editedAt) }));
  }

  // reactions, acknowledge, replies
  const foot = h("div", { class: "post-foot" });
  const rbox = h("div", { class: "reacts" });
  const reactions = p.reactions || {};
  for (const [key, emo] of REACTS) {
    const who = Object.keys(reactions).filter((u) => (reactions[u] || []).includes(key));
    if (!who.length) continue;
    const mine = who.includes(S.uid);
    rbox.append(h("button", { class: "react" + (mine ? " mine" : ""), type: "button", "aria-pressed": mine ? "true" : "false",
      title: who.map(nameOf).join(", "), onclick: () => toggleReact(p, key) }, `${emo} ${who.length}`));
  }
  if (S.picking === p.id) rbox.append(h("span", { class: "react-pick" }, REACTS.map(([key, emo]) =>
    h("button", { type: "button", "aria-label": "React " + key, onclick: () => { S.picking = null; toggleReact(p, key); } }, emo))));
  else rbox.append(h("button", { class: "link-btn", type: "button", "aria-label": "Add reaction", onclick: () => { S.picking = p.id; schedule(); } }, "☺ React"));
  foot.append(rbox);

  if (p.author !== S.uid) foot.append(h("button", { class: "ack-btn" + (acked(p) ? " done" : ""), type: "button", "aria-pressed": acked(p) ? "true" : "false", onclick: () => toggleAck(p) }, acked(p) ? "✓ Acknowledged" : "Acknowledge"));
  if (ackIds.length) {
    const names = ackIds.map(nameOf);
    foot.append(h("span", { class: "ack-summary", title: "Acknowledged by " + names.join(", ") },
      h("span", { class: "stack" }, ackIds.slice(0, 5).map((id) => avatar(id, true))),
      h("span", { text: `Seen by ${names.slice(0, 2).join(", ")}${names.length > 2 ? " +" + (names.length - 2) : ""}` })));
  } else if (pr !== "update") foot.append(h("span", { class: "ack-summary", text: "No acknowledgements yet" }));
  if ((isAdmin() || p.author === S.uid) && pr !== "update") {
    const missing = audience(p).filter((u) => !acked(p, u.id));
    if (missing.length) foot.append(h("button", { class: "link-btn", type: "button", onclick: () => { S.showNotYet.has(p.id) ? S.showNotYet.delete(p.id) : S.showNotYet.add(p.id); schedule(); } }, `Not yet: ${missing.length}`));
  }
  const rc = p.replyCount || 0;
  foot.append(h("button", { class: "link-btn", type: "button", "aria-expanded": isOpen ? "true" : "false", onclick: () => toggleThread(p) },
    rc ? (isOpen ? "Hide replies" : `${rc} ${rc === 1 ? "reply" : "replies"}`) : (isOpen ? "Close" : "Reply")));
  node.append(foot);

  if (S.showNotYet.has(p.id)) {
    const missing = audience(p).filter((u) => !acked(p, u.id));
    node.append(h("div", { class: "notyet" }, h("span", { text: "Hasn't acknowledged: " + (missing.map((u) => u.name).join(", ") || "everyone has") }),
      isAdmin() && missing.length ? h("button", { class: "btn sm", type: "button", onclick: () => remind(p) }, "Remind them") : null));
  }

  if (isOpen) {
    const th = h("div", { class: "thread" });
    const replies = S.threads[p.id];
    if (!replies) th.append(h("span", { class: "mini", text: "Loading replies…" }));
    for (const r of replies || []) {
      th.append(h("div", { class: "reply" }, avatar(r.author, true),
        h("div", { class: "r-main" },
          h("div", null, h("span", { class: "author", text: nameOf(r.author) }), " ", h("span", { class: "time", text: when(r.createdAt) }),
            canModify(r) ? h("button", { class: "link-btn", type: "button", onclick: () => { S.confirm = "reply:" + r.id; schedule(); } }, "Delete") : null),
          S.confirm === "reply:" + r.id ? h("div", { class: "confirm" }, "Delete this reply?",
            h("button", { class: "btn danger solid sm", type: "button", onclick: () => { S.confirm = null; deleteDoc(doc(db, `posts/${p.id}/replies/${r.id}`)).catch(oops); } }, "Delete"),
            h("button", { class: "btn sm", type: "button", onclick: () => { S.confirm = null; schedule(); } }, "Cancel")) : null,
          h("div", { class: "post-body" }, richText(r.body)))));
    }
    const tid = "reply-" + p.id;
    const ta = h("textarea", { id: tid, placeholder: "Write a reply. Type @ to mention.", "aria-label": "Reply",
      oninput: (e) => { S.drafts[tid] = e.target.value; },
      onkeydown: (e) => { if (!pick && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(p); } } });
    ta.value = S.drafts[tid] || "";
    wireMentions(ta, tid);
    th.append(h("div", { class: "reply-box" }, ta, h("button", { class: "btn primary sm", type: "button", onclick: () => sendReply(p) }, "Send")));
    node.append(th);
  }
  return node;
}

// ---------- schedule editor ----------
function schedEditor(o, pfx) {
  o.days = o.days || DEFAULT_SCHED.days.slice();
  const days = h("div", { class: "days", role: "group", "aria-label": "Work days" }, DAY_LETTERS.map((L, i) => h("button", {
    type: "button", class: "day-btn", id: `${pfx}-d${i}`, "aria-pressed": o.days.includes(i) ? "true" : "false", title: DAY_NAMES[i], "aria-label": DAY_NAMES[i],
    onclick: (e) => { const set = new Set(o.days); set.has(i) ? set.delete(i) : set.add(i); o.days = [...set].sort(); e.currentTarget.setAttribute("aria-pressed", set.has(i) ? "true" : "false"); },
  }, L)));
  const time = (key, label) => { const el = h("input", { type: "time", id: `${pfx}-${key}`, "aria-label": label, oninput: (e) => { o[key] = e.target.value; } }); el.value = o[key] || ""; return el; };
  const pause = h("input", { type: "date", id: `${pfx}-pause`, "aria-label": "Pause notifications through", oninput: (e) => { o.pausedUntil = e.target.value; } });
  pause.value = o.pausedUntil || "";
  const off = h("input", { type: "checkbox", id: `${pfx}-off`, onchange: (e) => { o.off = e.target.checked; } });
  off.checked = !!o.off;
  return h("div", { class: "person" },
    h("div", { class: "row" }, h("span", { class: "mini", text: "Works" }), days),
    h("div", { class: "row" }, h("span", { class: "mini", text: "Hours" }), time("start", "Shift starts"), h("span", { class: "mini", text: "to" }), time("end", "Shift ends")),
    h("div", { class: "row" }, h("label", { class: "check" }, off, "Notifications off"), h("span", { class: "mini", text: "Pause through" }), pause));
}
function cleanSched(o) {
  o = normalize(o);
  if (toMin(o.start) >= toMin(o.end)) throw new Error("Shift end must be after shift start.");
  return { days: o.days.slice().sort(), start: o.start, end: o.end, pausedUntil: o.pausedUntil || "", off: !!o.off };
}

// ---------- settings ----------
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

function pushState() {
  if (isIOS() && !isStandalone()) return "install";
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission === "granted" && localStorageGet("hub.token")) return "on";
  return "off";
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function localStorageSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }

function renderPushNudge() {
  const n = $("pushNudge");
  const st = pushState();
  if (SPECIAL.includes(S.view) || st === "on" || st === "unsupported" || localStorageGet("hub.nudgeHidden")) { n.hidden = true; return; }
  n.hidden = false;
  n.replaceChildren(
    h("span", { text: st === "install" ? "To get notifications on iPhone or iPad, add Staff Hub to your Home Screen. " : st === "blocked" ? "Notifications are blocked for Staff Hub. Turn them on in your phone's settings. " : "Get a notification when there's a new update. " }),
    st === "off" ? h("button", { class: "btn sm gold", type: "button", onclick: () => enablePush(true) }, "Turn on notifications") : h("button", { class: "btn sm", type: "button", onclick: () => go("me") }, "Show me how"),
    " ", h("button", { class: "link-btn", type: "button", onclick: () => { localStorageSet("hub.nudgeHidden", "1"); renderPushNudge(); } }, "Not now"));
}

function settingsPanel() {
  const o = S.drafts.mySched = S.drafts.mySched || Object.assign({}, normalize(S.me.schedule));
  const st = pushState();
  const status = { on: "On for this device", off: "Off on this device", blocked: "Blocked in your phone or browser settings", install: "Add Staff Hub to your Home Screen first", unsupported: "This browser doesn't support notifications" }[st];
  const level = S.me.notify || "all";
  const radio = (val, label) => h("label", { class: "check" }, h("input", { type: "radio", name: "notify", value: val, checked: level === val, onchange: () => updateDoc(doc(db, "users", S.uid), { notify: val }).then(() => toast("Saved")).catch(oops) }), label);
  const now = Date.now();
  const schedStatus = isPaused(S.me.schedule, now) ? "Paused" : onShift(S.me.schedule, now) ? "Working now: notifications on" : "Off shift: notifications held";
  return h("div", { class: "staff-list" },
    h("section", { class: "panel" },
      h("h2", { text: "App notifications" }),
      h("p", null, "This device: ", h("strong", { text: status })),
      st === "off" ? h("button", { class: "btn gold", type: "button", onclick: () => enablePush(true) }, "Turn on notifications") : null,
      st === "on" ? h("div", { class: "row-gap" },
        h("button", { class: "btn", type: "button", onclick: () => call("sendTestNotification").then((r) => toast(r.sent ? "Test sent. It should arrive in a few seconds." : "No devices are set up yet.")).catch(oops) }, "Send me a test"),
        h("button", { class: "btn", type: "button", onclick: disablePush }, "Turn off on this device")) : null,
      st === "install" ? h("ol", { class: "steps" },
        h("li", null, "Open this page in ", h("strong", { text: "Safari" }), "."),
        h("li", null, "Tap the ", h("strong", { text: "Share" }), " button (square with an arrow)."),
        h("li", null, "Tap ", h("strong", { text: "Add to Home Screen" }), ", then ", h("strong", { text: "Add" }), "."),
        h("li", null, "Open Staff Hub from the new icon on your Home Screen and come back here to turn on notifications.")) : null,
      st === "blocked" ? h("p", { text: isIOS() ? "Go to Settings › Notifications › Staff Hub and allow notifications." : "Open your browser's site settings for Staff Hub and allow notifications." }) : null,
      h("div", { class: "field" }, h("span", { text: "Notify me about" }),
        h("div", { class: "radio-row" }, radio("all", "All posts"), radio("important", "Important, urgent and @mentions"), radio("off", "Nothing")))),
    h("section", { class: "panel" },
      h("div", { class: "row-gap", style: "align-items:center" }, h("h2", { text: "My work schedule" }), h("span", { class: "status-pill" + (schedStatus.startsWith("Working") ? "" : " off"), text: schedStatus })),
      h("p", { text: "Notifications only reach you during your work hours (Florida time). Important and urgent posts that come in while you're off arrive at the start of your next shift." }),
      schedEditor(o, "my"),
      h("div", { class: "row-gap" },
        h("button", { class: "btn primary", type: "button", onclick: () => { let s; try { s = cleanSched(o); } catch (e) { toast(e.message); return; } updateDoc(doc(db, "users", S.uid), { schedule: s }).then(() => { delete S.drafts.mySched; toast("Schedule saved"); }).catch(oops); } }, "Save schedule"))),
    emailPanel(),
    h("section", { class: "panel" },
      h("h2", { text: "Account" }),
      h("p", null, "Signed in as ", h("strong", { text: S.me.email || "" })),
      h("div", { class: "row-gap" },
        h("button", { class: "btn", type: "button", onclick: () => sendPasswordResetEmail(auth, S.me.email).then(() => toast("We emailed you a link to change your password.")).catch(oops) }, "Change password"),
        h("button", { class: "btn danger", type: "button", onclick: () => signOut(auth) }, "Sign out"))));
}

function emailPanel() {
  const pref = S.me.emailNotify || "all";
  const radio = (val, label) => h("label", { class: "check" }, h("input", { type: "radio", name: "emailNotify", value: val, checked: pref === val,
    onchange: () => updateDoc(doc(db, "users", S.uid), { emailNotify: val }).then(() => toast("Saved")).catch(oops) }), label);
  return h("section", { class: "panel" },
    h("div", { class: "row-gap", style: "align-items:center" }, h("h2", { text: "Email" }),
      h("span", { class: "status-pill" + (S.mail && pref !== "off" ? "" : " off"), text: S.mail === false ? "Not switched on yet" : pref === "off" ? "Off" : "On" })),
    h("p", null, "Posts are emailed to ", h("strong", { text: S.me.email || "your email" }), ". Emails follow your work schedule, so anything posted while you're off arrives at the start of your next shift."),
    S.mail === false ? h("p", { class: "mini", text: "Your manager hasn't switched email alerts on yet. Your choice below is saved for when they do." }) : null,
    h("div", { class: "field" }, h("span", { text: "Email me about" }),
      h("div", { class: "radio-row" }, radio("all", "All posts"), radio("important", "Important, urgent and @mentions"), radio("off", "Nothing"))),
    S.mail ? h("div", { class: "row-gap" }, h("button", { class: "btn", type: "button", onclick: () => call("sendTestEmail").then((r) => toast(`Test email sent to ${r.to}.`)).catch(oops) }, "Send me a test email")) : null);
}

function teamPanel() {
  const people = Object.entries(S.users).map(([id, u]) => Object.assign({ id }, u)).sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));
  return h("section", { class: "panel", style: "max-width:760px" },
    h("div", { class: "row-gap", style: "justify-content:space-between;align-items:center" }, h("h2", { text: `Team (${people.filter((p) => p.active).length})` }),
      h("button", { class: "btn gold", type: "button", onclick: () => staffModal(null) }, "＋ Invite staff")),
    h("p", { text: "Invited staff get an email to set their password. Managers can create channels, pin posts, see who hasn't acknowledged and manage staff." }),
    h("div", { class: "staff-list" }, people.map((u) => h("div", { class: "staff-row" },
      avatar(u.id),
      h("div", { class: "who" }, h("strong", { text: u.name || u.email }), h("span", { class: "mini", text: [u.title, u.email].filter(Boolean).join(" · ") }),
        h("span", { class: "mini", style: "display:block", text: schedText(u.schedule) })),
      h("span", { class: "row-gap" },
        u.role === "admin" ? h("span", { class: "chip role", text: "Manager" }) : null,
        (u.groups || []).includes("providers") ? h("span", { class: "chip grp", text: "Provider" }) : null,
        !u.active ? h("span", { class: "chip off", text: "Deactivated" }) : null),
      h("span", { class: "row-gap" },
        h("button", { class: "btn sm", type: "button", onclick: () => staffModal(u) }, "Edit"),
        u.active ? h("button", { class: "btn sm", type: "button", onclick: () => sendPasswordResetEmail(auth, u.email).then(() => toast(`Invite email sent to ${u.email}`)).catch(oops) }, "Resend invite") : null,
        u.id !== S.uid ? h("button", { class: "btn sm" + (u.active ? " danger" : ""), type: "button", onclick: () => call("setActive", { uid: u.id, active: !u.active }).then(() => toast(u.active ? "Deactivated" : "Reactivated")).catch(oops) }, u.active ? "Deactivate" : "Reactivate") : null)))));
}

// ---------- modals ----------
function openModal(title, fields, submitLabel, onSubmit) {
  const form = $("modalForm");
  form.replaceChildren(h("h2", { text: title }), ...fields,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: closeModal }, "Cancel"), h("button", { class: "btn primary", type: "submit" }, submitLabel)));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
    try { await onSubmit(); closeModal(); } catch (err) { if (err && err.message && !err.code) toast(err.message); else oops(err); } finally { btn.disabled = false; }
  };
  $("modal").hidden = false;
  const first = form.querySelector("input,select,textarea"); if (first) first.focus();
}
function closeModal() { $("modal").hidden = true; }
const field = (label, input) => h("label", { class: "field" }, h("span", { text: label }), input);
const input = (id, value, attrs) => { const el = h("input", Object.assign({ id }, attrs || {})); el.value = value || ""; return el; };
const select = (id, value, opts) => h("select", { id }, opts.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));

function communityModal(c) {
  const gen = c ? generalOf(c.id) : null;
  const fields = [
    h("div", { class: "row" }, field("Icon", input("fIcon", c ? c.icon : "", { maxlength: 4, class: "emoji-in", placeholder: "✦" })), h("div", { style: "flex:1" }, field("Name", input("fName", c ? c.name : "", { maxlength: 60, required: true })))),
    field("Description (optional)", input("fTopic", c ? c.topic : "", { maxlength: 160 })),
    field("Who can post in the main channel", select("fPolicy", gen ? gen.postPolicy || "everyone" : "everyone", [["everyone", "Everyone"], ["admins", "Managers only"]])),
    c ? h("p", { class: "mini", text: c.group === "all" ? "Visible to all staff." : "Visible to providers and managers only." })
      : field("Who can see it", select("fGroup", "all", [["all", "All staff"], ["providers", "Providers and managers only"]])),
  ];
  openModal(c ? "Edit community" : "Create a community", fields, c ? "Save" : "Create", async () => {
    const name = $("fName").value.trim(), icon = $("fIcon").value.trim() || "✦", topic = $("fTopic").value.trim(), postPolicy = $("fPolicy").value;
    if (!name) throw new Error("Enter a name.");
    if (c) {
      await updateDoc(doc(db, "communities", c.id), { name, icon, topic });
      if (gen) await updateDoc(doc(db, "channels", gen.id), { icon, postPolicy });
      toast("Community updated");
    } else {
      const group = $("fGroup").value;
      const order = Math.max(0, ...communities().map((x) => x.order || 0)) + 1;
      const cref = await addDoc(collection(db, "communities"), { name, icon, topic, group, order, createdAt: Date.now() });
      const gref = await addDoc(collection(db, "channels"), { communityId: cref.id, name: "General", general: true, icon, topic: "", group, postPolicy, order: 0, createdAt: Date.now() });
      go(gref.id);
    }
  });
}

function channelModal(c, ch) {
  const fields = [
    h("div", { class: "row" }, field("Icon", input("fIcon", ch ? ch.icon : "", { maxlength: 4, class: "emoji-in", placeholder: "#" })), h("div", { style: "flex:1" }, field("Name", input("fName", ch ? ch.name : "", { maxlength: 60, required: true })))),
    field("Description (optional)", input("fTopic", ch ? ch.topic : "", { maxlength: 160 })),
    field("Who can post", select("fPolicy", ch ? ch.postPolicy || "everyone" : "everyone", [["everyone", "Everyone"], ["admins", "Managers only"]])),
  ];
  openModal(ch ? "Edit channel" : `Add a channel to ${c.name}`, fields, ch ? "Save" : "Create", async () => {
    const name = $("fName").value.trim(), icon = $("fIcon").value.trim() || "#", topic = $("fTopic").value.trim(), postPolicy = $("fPolicy").value;
    if (!name) throw new Error("Enter a name.");
    if (ch) { await updateDoc(doc(db, "channels", ch.id), { name, icon, topic, postPolicy }); toast("Channel updated"); }
    else {
      const order = Math.max(0, ...channelsOf(c.id).map((x) => x.order || 0)) + 1;
      const r = await addDoc(collection(db, "channels"), { communityId: c.id, name, icon, topic, group: c.group, postPolicy, general: false, order, createdAt: Date.now() });
      go(r.id);
    }
  });
}

function staffModal(u) {
  const sch = Object.assign({}, normalize(u && u.schedule));
  const prov = h("input", { type: "checkbox", id: "fProv", checked: !!(u && (u.groups || []).includes("providers")) });
  const fields = [
    field("Name", input("fName", u ? u.name : "", { maxlength: 60, required: true })),
    u ? h("p", { class: "mini", text: u.email }) : field("Email", input("fEmail", "", { type: "email", required: true, placeholder: "name@enchantedmedicalaesthetics.com" })),
    field("Job title (optional)", input("fTitle", u ? u.title : "", { maxlength: 60, placeholder: "e.g. Front Desk, NP, Injector" })),
    field("Role", select("fRole", u ? u.role : "staff", [["staff", "Staff"], ["admin", "Manager"]])),
    h("label", { class: "check" }, prov, "Provider (can see Providers Only)"),
    h("div", { class: "field" }, h("span", { text: "Work schedule (for notifications)" }), schedEditor(sch, "fs")),
  ];
  openModal(u ? `Edit ${u.name}` : "Invite staff", fields, u ? "Save" : "Send invite", async () => {
    const name = $("fName").value.trim(); if (!name) throw new Error("Enter a name.");
    const data = { name, title: $("fTitle").value.trim(), role: $("fRole").value, groups: $("fProv").checked ? ["providers"] : [], schedule: cleanSched(sch) };
    if (u) {
      if (u.id === S.uid && data.role !== "admin") throw new Error("You can't remove your own manager role.");
      await updateDoc(doc(db, "users", u.id), data); toast("Saved");
    } else {
      const email = $("fEmail").value.trim().toLowerCase();
      await call("inviteStaff", Object.assign({ email }, data));
      await sendPasswordResetEmail(auth, email);
      toast(`Invite sent to ${email}. They'll get an email to set their password.`, 6000);
    }
  });
}

function linkModal(ta) {
  const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
  openModal("Add a link", [
    field("Link (Google Drive, a website, anything)", input("fUrl", "", { type: "url", required: true, placeholder: "https://docs.google.com/…" })),
    field("Name to show (optional)", input("fLabel", sel, { maxlength: 80, placeholder: "e.g. SkinMedica training guide" })),
    h("p", { class: "mini", text: "For Google Drive files, check sharing first: in Drive tap Share, then under General access choose Enchanted Medical Aesthetics (or Anyone with the link). Otherwise staff will see \"Request access\"." }),
  ], "Add link", async () => {
    let url = $("fUrl").value.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(url)) throw new Error("Enter a full link, like https://docs.google.com/…");
    const label = $("fLabel").value.trim().replace(/[\[\]]/g, "");
    const text = label ? `[${label}](${url})` : url;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(s + text.length, s + text.length); }, 0);
  });
}

function filesPanel(ch) {
  const q = S.query.trim().toLowerCase();
  let items = [];
  const seen = new Set();
  allPosts().filter((p) => p.channelId === ch.id).sort((a, b) => b.createdAt - a.createdAt).forEach((p) => {
    for (const f of filesIn(p)) { if (!seen.has(f.url)) { seen.add(f.url); items.push(f); } }
  });
  if (q) items = items.filter((f) => `${f.name} ${KINDS[f.kind][1]}`.toLowerCase().includes(q));
  if (!items.length) return [h("div", { class: "empty" }, h("h2", { text: q ? "No matching files" : "No files yet" }),
    h("p", { text: q ? "Try a different word." : "Photos, PDFs, documents and Google Drive links posted in this channel will be collected here." }))];
  const photos = items.filter((f) => f.kind === "image"), docs = items.filter((f) => f.kind !== "image");
  const out = [];
  if (docs.length) {
    out.push(h("div", { class: "section-label", text: `Documents and links (${docs.length})` }));
    out.push(h("div", { class: "file-list" }, docs.map((f) => h("div", { class: "file-row" },
      badge(f.kind),
      h("div", { class: "file-main" }, h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", text: f.name }),
        h("span", { class: "mini", text: `${KINDS[f.kind][1]} · ${nameOf(f.post.author)} · ${when(f.post.createdAt)}` })),
      h("button", { class: "link-btn", type: "button", onclick: () => { S.tab = "posts"; S.flash = f.post.id; schedule(); } }, "View post")))));
  }
  if (photos.length) {
    out.push(h("div", { class: "section-label", text: `Photos (${photos.length})` }));
    out.push(h("div", { class: "photo-grid" }, photos.map((f) => h("a", { href: f.url, target: "_blank", rel: "noopener", title: f.name }, h("img", { src: f.url, alt: f.name, loading: "lazy" })))));
  }
  return out;
}

// ---------- actions ----------
function go(view) {
  S.view = view; S.tab = "posts"; S.query = ""; $("search").value = ""; S.confirm = null; S.editing = null; S.picking = null; delete S.drafts.mySched;
  $("app").classList.add("show-main");
  $("feedWrap").scrollTop = 0; schedule();
}
function updatePost(p, data) { return updateDoc(doc(db, "posts", p.id), data).catch(oops); }
function toggleAck(p) { return updatePost(p, { [`acks.${S.uid}`]: acked(p) ? deleteField() : Date.now() }); }
function toggleReact(p, key) {
  const mine = new Set(((p.reactions || {})[S.uid]) || []);
  mine.has(key) ? mine.delete(key) : mine.add(key);
  return updatePost(p, { [`reactions.${S.uid}`]: mine.size ? [...mine] : deleteField() });
}
function toggleThread(p) {
  if (S.open.has(p.id)) {
    S.open.delete(p.id);
    if (S.threadUnsubs[p.id]) { S.threadUnsubs[p.id](); delete S.threadUnsubs[p.id]; delete S.threads[p.id]; }
  } else {
    S.open.add(p.id);
    S.threadUnsubs[p.id] = onSnapshot(query(collection(db, `posts/${p.id}/replies`), orderBy("createdAt")), (snap) => {
      S.threads[p.id] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())); schedule();
    }, (e) => oops(e, "Couldn't load replies."));
  }
  schedule();
}
async function sendReply(p) {
  const tid = "reply-" + p.id;
  const raw = (S.drafts[tid] || "").trim(); if (!raw) return;
  const { text, mentions } = encodeMentions(raw, S.maps[tid]);
  S.drafts[tid] = ""; S.maps[tid] = {}; const el = $(tid); if (el) el.value = "";
  try { await addDoc(collection(db, `posts/${p.id}/replies`), { author: S.uid, body: text, mentions, createdAt: Date.now() }); }
  catch (e) { S.drafts[tid] = raw; oops(e, "Your reply didn't send."); schedule(); }
}
async function saveEdit(p) {
  const tid = "edit-" + p.id, sid = "edit-s-" + p.id;
  const raw = ($(tid) ? $(tid).value : "").trim(), subject = ($(sid) ? $(sid).value : "").trim();
  if (!raw && !subject) { toast("A post can't be empty."); return; }
  const { text, mentions } = encodeMentions(raw, S.maps[tid]);
  try { await updateDoc(doc(db, "posts", p.id), { subject, body: text, mentions, editedAt: Date.now() }); S.editing = null; schedule(); toast("Saved"); }
  catch (e) { oops(e); }
}
async function remind(p) {
  try {
    const r = await call("remindUnacknowledged", { postId: p.id });
    toast(r.total ? `Reminder sent to ${r.now} now${r.later ? `, ${r.later} at the start of their next shift` : ""}.` : "Everyone has acknowledged.", 6000);
  } catch (e) { oops(e); }
}
async function removeChannelOrCommunity(ch, c) {
  S.confirm = null;
  try {
    if (ch.general) await deleteDoc(doc(db, "communities", c.id));
    else await deleteDoc(doc(db, "channels", ch.id));
    S.view = ch.general ? "activity" : (generalOf(c.id) || {}).id || "activity";
    toast(ch.general ? "Community deleted" : "Channel deleted");
  } catch (e) { oops(e); }
}
async function seed() {
  try { const r = await call("seedDefaults"); toast(r.created ? `Loaded ${r.created} communities.` : "Communities already exist."); } catch (e) { oops(e); }
}

async function addFiles(files) {
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(`${f.name} is over 20 MB. Choose a smaller file.`); continue; }
    const type = mimeFor(f);
    if (!Object.values(EXT_MIME).includes(type) && !type.startsWith("image/")) { toast(`${f.name} can't be attached. Use a photo, PDF, Word, Excel or PowerPoint file.`); continue; }
    const item = { name: f.name, type, uploading: true };
    S.pending.push(item); renderPending();
    try {
      const path = `uploads/${S.uid}/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, "_")}`;
      const r = storageRef(storage, path);
      await uploadBytes(r, f, { contentType: type });
      Object.assign(item, { url: await getDownloadURL(r), path, uploading: false });
    } catch (e) { S.pending = S.pending.filter((x) => x !== item); oops(e, `Couldn't upload ${f.name}. Check your connection and try again.`); }
    renderPending();
  }
}
function resetComposer() {
  $("cSubject").value = ""; $("cBody").value = ""; $("pri-update").checked = true; $("cBreak").checked = false;
  S.pending = []; S.maps.compose = {}; S.composing = false; localStorageSet("hub.draft", null); schedule();
}
async function createPost() {
  const subject = $("cSubject").value.trim(), raw = $("cBody").value.trim();
  const ch = chan(S.view);
  if ((!raw && !subject) || !canPostIn(ch) || S.busy) return;
  if (S.pending.some((f) => f.uploading)) { toast("Wait for the upload to finish."); return; }
  const priority = (document.querySelector('input[name="pri"]:checked') || {}).value || "update";
  const { text, mentions } = encodeMentions(raw, S.maps.compose);
  const post = {
    channelId: ch.id, communityId: ch.communityId, group: ch.group || "all", author: S.uid, subject, body: text, priority, mentions,
    attachments: S.pending.map((f) => ({ url: f.url, path: f.path, name: f.name, type: f.type })),
    pinned: false, reachAll: priority === "urgent" && $("cBreak").checked, acks: {}, reactions: {}, replyCount: 0, createdAt: Date.now(),
  };
  S.busy = true; $("postBtn").disabled = true;
  try {
    await addDoc(collection(db, "posts"), post);
    resetComposer();
    toast(priority === "update" ? "Posted" : "Posted. Everyone will be asked to acknowledge it.");
  } catch (e) { oops(e, "Your post didn't send. Try again."); }
  finally { S.busy = false; $("postBtn").disabled = false; }
}

// ---------- push notifications ----------
async function enablePush(interactive) {
  try {
    if (!VAPID_KEY) { if (interactive) toast("Notifications aren't set up on the server yet."); return; }
    if (!(await messagingSupported())) { if (interactive) toast(isIOS() ? "Add Staff Hub to your Home Screen first." : "This browser doesn't support notifications."); return; }
    let perm = Notification.permission;
    if (perm === "default" && interactive) perm = await Notification.requestPermission();
    if (perm !== "granted") { if (interactive) toast("Notifications weren't allowed."); schedule(); return; }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) throw new Error("No token");
    await setDoc(doc(db, `users/${S.uid}/tokens/${token}`), { createdAt: Date.now(), device: navigator.userAgent.slice(0, 180) });
    localStorageSet("hub.token", token);
    if (interactive) toast("Notifications are on for this device.");
  } catch (e) { console.error(e); if (interactive) toast("Couldn't turn on notifications. Try again in a moment."); }
  schedule();
}
async function disablePush() {
  const t = localStorageGet("hub.token");
  if (t) await deleteDoc(doc(db, `users/${S.uid}/tokens/${t}`)).catch(() => {});
  localStorageSet("hub.token", null);
  toast("Notifications are off for this device."); schedule();
}

// ---------- listeners ----------
function stopAll() {
  S.unsubs.forEach((u) => u()); S.unsubs = [];
  Object.values(S.threadUnsubs).forEach((u) => u()); S.threadUnsubs = {}; S.threads = {};
  Object.assign(S, { me: null, users: {}, groupKey: "", communities: {}, channels: {}, posts: {}, loaded: new Set(), view: null, open: new Set() });
}
let groupUnsubs = [];
function subscribeGroups() {
  const groups = myGroups(), key = groups.join(",");
  if (key === S.groupKey) return;
  S.groupKey = key;
  groupUnsubs.forEach((u) => u()); groupUnsubs = [];
  S.communities = {}; S.channels = {}; S.posts = {};
  const into = (bucket, g, name) => (snap) => {
    for (const ch of snap.docChanges()) {
      if (ch.type === "removed") delete S[bucket][ch.doc.id];
      else S[bucket][ch.doc.id] = Object.assign({ id: ch.doc.id }, ch.doc.data());
    }
    if (g === "all") S.loaded.add(`${name}:all`);
    schedule();
  };
  for (const g of groups) {
    groupUnsubs.push(onSnapshot(query(collection(db, "communities"), where("group", "==", g)), into("communities", g, "communities"), (e) => oops(e, "Couldn't load communities.")));
    groupUnsubs.push(onSnapshot(query(collection(db, "channels"), where("group", "==", g)), into("channels", g, "channels"), (e) => oops(e, "Couldn't load channels.")));
    groupUnsubs.push(onSnapshot(query(collection(db, "posts"), where("group", "==", g), orderBy("createdAt", "desc"), limit(400)), into("posts", g, "posts"), (e) => oops(e, "Couldn't load posts.")));
  }
}
function start(uid) {
  S.uid = uid;
  S.unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    S.users = {}; snap.docs.forEach((d) => { S.users[d.id] = d.data(); });
    S.me = S.users[uid] || null;
    if (!S.me || !S.me.active) { signOut(auth); return; }
    showApp(); subscribeGroups(); schedule();
  }, (e) => { oops(e, "Couldn't load your account."); }));
  S.unsubs.push(onSnapshot(doc(db, `users/${uid}/private/state`), (d) => { S.lastSeen = Object.assign({}, (d.data() || {}).lastSeen, S.lastSeen); schedule(); }, () => {}));
  S.unsubs.push(() => { groupUnsubs.forEach((u) => u()); groupUnsubs = []; });
  call("emailStatus").then((r) => { S.mail = !!r.enabled; schedule(); }).catch(() => { S.mail = false; });
  if (pushState() === "on" || (("Notification" in window) && Notification.permission === "granted")) enablePush(false);
}

function showGate(msg) { $("splash").hidden = true; $("app").hidden = true; $("gate").hidden = false; if (msg) $("gateMsg").textContent = msg; }
function showApp() { $("splash").hidden = true; $("gate").hidden = true; $("app").hidden = false; }

function openFromLink(link) {
  const m = String(link || location.hash).match(/#post-([A-Za-z0-9_-]+)/);
  if (!m) return;
  const p = S.posts[m[1]];
  if (p) { S.flash = p.id; go(p.channelId); history.replaceState(null, "", location.pathname); }
  else setTimeout(() => { if (S.posts[m[1]]) openFromLink(link); }, 1500);
}

// ---------- wiring ----------
function wire() {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("loginErr"); err.hidden = true; $("loginBtn").disabled = true;
    try { await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPass").value); }
    catch (x) { err.textContent = /invalid|wrong|not-found|credential/.test(x.code || "") ? "That email and password don't match. Use \"Forgot\" to set a new password." : "Couldn't sign in. Check your connection and try again."; err.hidden = false; }
    finally { $("loginBtn").disabled = false; }
  });
  $("forgotBtn").addEventListener("click", async () => {
    const email = $("loginEmail").value.trim();
    if (!email) { $("loginErr").textContent = "Enter your email first, then tap this again."; $("loginErr").hidden = false; return; }
    try { await sendPasswordResetEmail(auth, email); } catch (e) { /* don't reveal whether the account exists */ }
    $("loginErr").hidden = true; $("gateMsg").textContent = `If ${email} has been invited, a link to set your password is on its way. Check your inbox and spam folder.`;
  });
  $("activityBtn").addEventListener("click", () => go("activity"));
  $("backBtn").addEventListener("click", () => $("app").classList.remove("show-main"));
  $("addCommBtn").addEventListener("click", () => communityModal(null));
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  $("newPostBtn").addEventListener("click", () => { S.composing = true; schedule(); setTimeout(() => $("cSubject").focus(), 30); });
  $("cancelPost").addEventListener("click", resetComposer);
  $("postBtn").addEventListener("click", createPost);
  $("attachBtn").addEventListener("click", () => $("fileIn").click());
  $("fileIn").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  ["pri-update", "pri-important", "pri-urgent"].forEach((id) => $(id).addEventListener("change", schedule));
  document.querySelectorAll(".tool[data-fmt]").forEach((b) => b.addEventListener("click", () => {
    const ta = $("cBody"), f = b.dataset.fmt, s = ta.selectionStart, e = ta.selectionEnd;
    if (f === "bold") { const sel = ta.value.slice(s, e) || "bold text"; ta.value = ta.value.slice(0, s) + "**" + sel + "**" + ta.value.slice(e); ta.focus(); ta.setSelectionRange(s + 2, s + 2 + sel.length); }
    else if (f === "heading" || f === "list") { const pre = f === "heading" ? "# " : "- "; const ls = ta.value.lastIndexOf("\n", s - 1) + 1; ta.value = ta.value.slice(0, ls) + pre + ta.value.slice(ls); ta.focus(); ta.setSelectionRange(s + 2, s + 2); }
    else if (f === "link") linkModal(ta);
    else { ta.value = ta.value.slice(0, s) + "@" + ta.value.slice(e); ta.focus(); ta.setSelectionRange(s + 1, s + 1); onMentionInput(ta, "compose"); }
  }));
  wireMentions($("cBody"), "compose");
  $("cBody").addEventListener("keydown", (e) => { if (!pick && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); createPost(); } });
  $("cBody").addEventListener("input", (e) => localStorageSet("hub.draft", e.target.value));
  const draft = localStorageGet("hub.draft"); if (draft) { $("cBody").value = draft; S.composing = true; }
  $("search").addEventListener("input", (e) => { S.query = e.target.value; schedule(); });
  window.addEventListener("resize", () => { if (pick) drawPick(); });
  window.addEventListener("hashchange", () => openFromLink());
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "open") openFromLink(e.data.link); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
}

async function main() {
  wire();
  let cfg;
  try { cfg = await (await fetch("/__/firebase/init.json")).json(); }
  catch (e) { $("splash").replaceChildren(h("span", { class: "brand-title", text: "Staff Hub" }), h("span", { class: "muted", text: "Can't reach the server. Check your connection and reload." })); return; }
  fb = initializeApp(cfg);
  auth = getAuth(fb);
  try { db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { db = initializeFirestore(fb, { localCache: memoryLocalCache() }); }
  storage = getStorage(fb);
  fns = getFunctions(fb, "us-central1");
  if (["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("emulators")) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectStorageEmulator(storage, "127.0.0.1", 9199);
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  onAuthStateChanged(auth, async (u) => {
    stopAll();
    if (!u) { showGate(); return; }
    try {
      const r = await call("bootstrap");
      if (r.status === "ok") { start(u.uid); setTimeout(() => openFromLink(), 800); return; }
      await signOut(auth);
      showGate(r.status === "inactive" ? "Your account has been deactivated. Talk to your manager." : "This email hasn't been invited yet. Ask your manager to invite you.");
    } catch (e) { console.error(e); showGate("Couldn't reach the server. Check your connection and try again."); }
  });
}
main();
