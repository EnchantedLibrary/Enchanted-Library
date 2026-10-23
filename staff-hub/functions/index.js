// Enchanted Staff Hub: server side.
// Sends push notifications that respect each person's work schedule, holds alerts for
// people who are off until their next shift, manages staff accounts, and keeps reply
// counts and cascading deletes tidy.
const crypto = require("crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const sched = require("./schedule");
const SEED = require("./seed.json");

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const OWNER_EMAILS = (process.env.OWNER_EMAILS || "info@enchantedmedicalaesthetics.com")
  .toLowerCase().split(/[\s,;]+/).filter(Boolean);
const GROUPS = ["all", "providers"];
const APP_URL = process.env.APP_URL || `https://${process.env.GCLOUD_PROJECT || "staff-hub"}.web.app`;
// Text messages go out through Twilio once these are set (see SETUP.md). Until then texting stays off.
const TW = { sid: process.env.TWILIO_ACCOUNT_SID || "", token: process.env.TWILIO_AUTH_TOKEN || "", from: process.env.TWILIO_FROM || "" };
const textingOn = () => !!(TW.sid && TW.token && TW.from);

// ---------- helpers ----------
async function requireUser(req, managersOnly) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const snap = await db.doc(`users/${req.auth.uid}`).get();
  const u = snap.data();
  if (!u || !u.active) throw new HttpsError("permission-denied", "Your account isn't active.");
  if (managersOnly && u.role !== "admin") throw new HttpsError("permission-denied", "Only managers can do that.");
  return Object.assign({ id: snap.id }, u);
}

const inGroup = (u, group) => group === "all" || u.role === "admin" || (u.groups || []).includes(group);

async function audience(group, excludeUid) {
  const snap = await db.collection("users").where("active", "==", true).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))
    .filter((u) => u.id !== excludeUid && inGroup(u, group));
}

function plain(text) {
  return String(text || "")
    .replace(/<@([^>]+)>/g, "@someone")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\s+/g, " ").trim();
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function where(post) {
  const [ch, cm] = await Promise.all([
    db.doc(`channels/${post.channelId}`).get(),
    db.doc(`communities/${post.communityId}`).get(),
  ]);
  const c = cm.data() || {}, h = ch.data() || {};
  return h.general ? (c.name || "Staff Hub") : `${c.name || "Staff Hub"} › ${h.name || ""}`;
}

async function nameOf(uid) {
  const s = await db.doc(`users/${uid}`).get();
  return (s.data() && s.data().name) || "Someone";
}

// Send one notification to every device a person has registered.
async function pushTo(uid, msg) {
  const toks = await db.collection(`users/${uid}/tokens`).get();
  if (toks.empty) return 0;
  const tokens = toks.docs.map((d) => d.id);
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: { title: msg.title, body: msg.body, link: msg.link || "/", tag: msg.tag || "" },
    webpush: { headers: { Urgency: msg.urgent ? "high" : "normal", TTL: "86400" } },
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument") dead.push(tokens[i]);
  });
  await Promise.all(dead.map((t) => db.doc(`users/${uid}/tokens/${t}`).delete()));
  return res.successCount;
}

// Send a text if the person opted in and the alert is at the level they chose.
async function textTo(uid, msg, force) {
  if (!textingOn()) return false;
  const c = (await db.doc(`users/${uid}/private/contact`).get()).data();
  if (!c || !c.phone || !c.consentAt) return false;
  const pref = c.sms || "urgent", lvl = msg.level;
  const wanted = force || (pref === "urgent" && lvl === "urgent") || (pref === "important" && (lvl === "urgent" || lvl === "important"));
  if (!wanted) return false;
  // Plain characters only, so carriers bill each text as one standard message.
  const gsm = (t) => String(t).replace(/[·•]/g, "-").replace(/[›»]/g, ">").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x20-\x7E]/g, "");
  const body = gsm(`Enchanted Staff Hub: ${clip(msg.title, 90)}${msg.smsText ? " - " + clip(msg.smsText, 90) : ""} ${APP_URL}${msg.link || "/"}`);
  const params = { To: c.phone, Body: body };
  if (TW.from.startsWith("MG")) params.MessagingServiceSid = TW.from; else params.From = TW.from;
  const r = await fetch(`${process.env.TWILIO_API_BASE || "https://api.twilio.com"}/2010-04-01/Accounts/${TW.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${TW.sid}:${TW.token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!r.ok) console.error("text failed", uid, r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

async function notifyNow(uid, msg) {
  const results = await Promise.allSettled([pushTo(uid, msg), textTo(uid, msg)]);
  results.forEach((r) => { if (r.status === "rejected") console.error("notify failed", uid, r.reason && r.reason.message); });
}

// Deliver now if the person is working, otherwise hold it for their next shift (when allowed).
async function deliver(user, msg, { force = false, holdIfOff = true, key } = {}) {
  const now = Date.now();
  if (force || sched.onShift(user.schedule, now)) { await notifyNow(user.id, msg); return "now"; }
  if (!holdIfOff) return "skipped";
  const due = sched.nextShift(user.schedule, now);
  if (!due) return "skipped";
  const id = key ? `${key}_${user.id}` : db.collection("queue").doc().id;
  await db.doc(`queue/${id}`).set({ uid: user.id, dueAt: due, msg, createdAt: now });
  return "later";
}

const wants = (u, { important, mentioned }) => {
  const level = u.notify || "all";
  if (level === "off") return false;
  if (level === "important") return important || mentioned;
  return true;
};

// ---------- accounts ----------
exports.bootstrap = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const ref = db.doc(`users/${req.auth.uid}`);
  const snap = await ref.get();
  if (snap.exists) return { status: snap.data().active ? "ok" : "inactive" };
  const email = String(req.auth.token.email || "").toLowerCase();
  if (!OWNER_EMAILS.includes(email)) return { status: "not-invited" };
  await ref.set({
    name: req.auth.token.name || "Owner", email, title: "Owner", role: "admin", groups: ["providers"],
    active: true, schedule: sched.clean({}), notify: "all", createdAt: Date.now(),
  });
  return { status: "ok" };
});

exports.inviteStaff = onCall(async (req) => {
  await requireUser(req, true);
  const d = req.data || {};
  const email = String(d.email || "").trim().toLowerCase();
  const name = String(d.name || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email address.");
  if (!name) throw new HttpsError("invalid-argument", "Enter the person's name.");
  let user = null;
  try { user = await getAuth().getUserByEmail(email); } catch (e) { if (e.code !== "auth/user-not-found") throw e; }
  if (user) await getAuth().updateUser(user.uid, { disabled: false, displayName: name });
  else user = await getAuth().createUser({ email, displayName: name, password: crypto.randomBytes(24).toString("base64url") });
  const prev = (await db.doc(`users/${user.uid}`).get()).data() || {};
  await db.doc(`users/${user.uid}`).set({
    name, email, title: String(d.title || "").slice(0, 60),
    role: d.role === "admin" ? "admin" : "staff",
    groups: (d.groups || []).filter((g) => GROUPS.includes(g) && g !== "all"),
    active: true, schedule: sched.clean(d.schedule), notify: prev.notify || "all",
    createdAt: prev.createdAt || Date.now(),
  }, { merge: true });
  return { uid: user.uid, existed: !!prev.email };
});

exports.setActive = onCall(async (req) => {
  const me = await requireUser(req, true);
  const { uid, active } = req.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "Missing person.");
  if (uid === me.id && !active) throw new HttpsError("failed-precondition", "You can't deactivate your own account.");
  await getAuth().updateUser(uid, { disabled: !active });
  if (!active) {
    await getAuth().revokeRefreshTokens(uid);
    const toks = await db.collection(`users/${uid}/tokens`).get();
    await Promise.all(toks.docs.map((t) => t.ref.delete()));
  }
  await db.doc(`users/${uid}`).update({ active: !!active });
  return { ok: true };
});

exports.seedDefaults = onCall(async (req) => {
  await requireUser(req, true);
  const existing = await db.collection("communities").limit(1).get();
  if (!existing.empty) return { created: 0 };
  const batch = db.batch();
  let n = 0;
  SEED.forEach((c, i) => {
    const group = c.group || "all";
    const cref = db.collection("communities").doc();
    batch.set(cref, { name: c.name, icon: c.icon, topic: c.topic || "", group, order: i + 1, createdAt: Date.now() });
    batch.set(db.collection("channels").doc(), { communityId: cref.id, name: "General", general: true, icon: c.icon, topic: "", group, postPolicy: c.postPolicy || "everyone", order: 0, createdAt: Date.now() });
    (c.channels || []).forEach((ch, j) => {
      batch.set(db.collection("channels").doc(), { communityId: cref.id, name: ch.name, icon: ch.icon, topic: "", group, postPolicy: "everyone", general: false, order: j + 1, createdAt: Date.now() });
    });
    n++;
  });
  await batch.commit();
  return { created: n };
});

// ---------- notifications ----------
exports.onPostCreated = onDocumentCreated("posts/{postId}", async (event) => {
  const post = event.data && event.data.data();
  if (!post) return;
  const postId = event.params.postId;
  const [place, author, people] = await Promise.all([where(post), nameOf(post.author), audience(post.group || "all", post.author)]);
  const important = post.priority === "important" || post.priority === "urgent";
  const label = post.priority === "urgent" ? "URGENT · " : post.priority === "important" ? "Important · " : "";
  const text = clip(`${author}: ${post.subject ? post.subject + " — " : ""}${plain(post.body)}`, 180);
  const link = `/#post-${postId}`;
  await Promise.all(people.map((u) => {
    const mentioned = (post.mentions || []).includes(u.id);
    if (!wants(u, { important, mentioned })) return null;
    const msg = {
      title: mentioned ? `${author} mentioned you · ${place}` : `${label}${place}`, body: text, link, tag: `post-${postId}`,
      urgent: post.priority === "urgent", level: post.priority || "update", smsText: post.subject || clip(plain(post.body), 80),
    };
    return deliver(u, msg, { force: post.priority === "urgent" && post.reachAll === true, holdIfOff: important || mentioned, key: `post-${postId}` });
  }));
});

exports.onReplyCreated = onDocumentCreated("posts/{postId}/replies/{replyId}", async (event) => {
  const reply = event.data && event.data.data();
  if (!reply) return;
  const postId = event.params.postId;
  const postRef = db.doc(`posts/${postId}`);
  const postSnap = await postRef.get();
  if (!postSnap.exists) return;
  const post = postSnap.data();
  await postRef.update({ replyCount: FieldValue.increment(1), lastReplyAt: reply.createdAt || Date.now() });

  // Notify the post's author, anyone mentioned, and earlier people in the thread.
  const earlier = await postRef.collection("replies").select("author").get();
  const targets = new Set([post.author, ...(reply.mentions || []), ...earlier.docs.map((d) => d.get("author"))]);
  targets.delete(reply.author);
  if (!targets.size) return;
  const [place, author, people] = await Promise.all([where(post), nameOf(reply.author), audience(post.group || "all", reply.author)]);
  const link = `/#post-${postId}`;
  await Promise.all(people.filter((u) => targets.has(u.id)).map((u) => {
    const mentioned = (reply.mentions || []).includes(u.id);
    if (!wants(u, { important: false, mentioned: mentioned || u.id === post.author })) return null;
    const msg = {
      title: mentioned ? `${author} mentioned you · ${place}` : `${author} replied · ${place}`,
      body: clip(plain(reply.body), 180), link, tag: `post-${postId}`,
    };
    return deliver(u, msg, { holdIfOff: mentioned, key: `reply-${event.params.replyId}` });
  }));
});

exports.onReplyDeleted = onDocumentDeleted("posts/{postId}/replies/{replyId}", async (event) => {
  const postRef = db.doc(`posts/${event.params.postId}`);
  const snap = await postRef.get();
  if (snap.exists && (snap.get("replyCount") || 0) > 0) await postRef.update({ replyCount: FieldValue.increment(-1) });
});

exports.remindUnacknowledged = onCall(async (req) => {
  await requireUser(req, true);
  const postId = String((req.data || {}).postId || "");
  const snap = await db.doc(`posts/${postId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "That post no longer exists.");
  const post = snap.data();
  const acked = post.acks || {};
  const people = (await audience(post.group || "all", post.author)).filter((u) => !acked[u.id]);
  const place = await where(post);
  const msg = {
    title: `Please acknowledge · ${place}`, body: clip(post.subject || plain(post.body), 180), link: `/#post-${postId}`, tag: `post-${postId}`,
    level: post.priority || "important", smsText: post.subject || clip(plain(post.body), 80),
  };
  let now = 0, later = 0;
  for (const u of people) {
    const r = await deliver(u, msg, { holdIfOff: true, key: `remind-${postId}` });
    if (r === "now") now++; else if (r === "later") later++;
  }
  return { now, later, total: people.length };
});

exports.sendTestNotification = onCall(async (req) => {
  const me = await requireUser(req, false);
  const sent = await pushTo(me.id, { title: "Staff Hub notifications are on", body: "You'll get alerts like this during your work hours.", link: "/" });
  return { sent };
});

exports.textingStatus = onCall(async (req) => {
  await requireUser(req, false);
  return { enabled: textingOn() };
});

exports.sendTestText = onCall(async (req) => {
  const me = await requireUser(req, false);
  if (!textingOn()) throw new HttpsError("failed-precondition", "Text alerts aren't switched on yet.");
  const ok = await textTo(me.id, { title: "Text alerts are on", smsText: "You'll get texts like this for the alerts you chose.", link: "/" }, true);
  if (!ok) throw new HttpsError("failed-precondition", "Save your mobile number and agree to texts first, then try again.");
  return { sent: true };
});

exports.sendQueued = onSchedule({ schedule: "every 10 minutes", timeZone: sched.TZ }, async () => {
  const due = await db.collection("queue").where("dueAt", "<=", Date.now()).limit(300).get();
  for (const d of due.docs) {
    const { uid, msg } = d.data();
    const u = (await db.doc(`users/${uid}`).get()).data();
    if (u && u.active && (u.notify || "all") !== "off" && !sched.isPaused(u.schedule, Date.now())) {
      await notifyNow(uid, msg);
    }
    await d.ref.delete();
  }
});

// ---------- cascading deletes ----------
exports.onPostDeleted = onDocumentDeleted("posts/{postId}", async (event) => {
  await db.recursiveDelete(db.collection(`posts/${event.params.postId}/replies`));
});
exports.onChannelDeleted = onDocumentDeleted("channels/{channelId}", async (event) => {
  const posts = await db.collection("posts").where("channelId", "==", event.params.channelId).get();
  await Promise.all(posts.docs.map((p) => p.ref.delete()));
});
exports.onCommunityDeleted = onDocumentDeleted("communities/{communityId}", async (event) => {
  const chans = await db.collection("channels").where("communityId", "==", event.params.communityId).get();
  await Promise.all(chans.docs.map((c) => c.ref.delete()));
});
