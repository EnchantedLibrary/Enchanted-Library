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
const nodemailer = require("nodemailer");
const sched = require("./schedule");
const SEED = require("./seed.json");
const TEAMS_POSTS = require("./import/teams-posts.json");

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const OWNER_EMAILS = (process.env.OWNER_EMAILS || "info@enchantedmedicalaesthetics.com")
  .toLowerCase().split(/[\s,;]+/).filter(Boolean);
const GROUPS = ["all", "providers"];
const APP_URL = process.env.APP_URL || `https://${process.env.GCLOUD_PROJECT || "staff-hub"}.web.app`;
// Email alerts go out from the office Gmail once these are set (see SETUP.md). Until then email stays off.
const MAIL = {
  user: process.env.MAIL_USER || "", pass: process.env.MAIL_APP_PASSWORD || "",
  host: process.env.MAIL_HOST || "smtp.gmail.com", port: Number(process.env.MAIL_PORT || 465),
};
const mailOn = () => !!(MAIL.user && MAIL.pass);
let transport = null;
const mailer = () => transport || (transport = nodemailer.createTransport({
  host: MAIL.host, port: MAIL.port, secure: MAIL.port === 465, auth: { user: MAIL.user, pass: MAIL.pass },
}));

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
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
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

const esc = (t) => String(t || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Turn a post's simple formatting (**bold**, # heading, - list, @mentions, links) into email HTML.
function postHtml(text, names) {
  const inline = (line) => esc(line)
    .replace(/&lt;@([A-Za-z0-9_-]+)&gt;/g, (m, id) => `<span style="color:#5b4eb0;font-weight:600">@${esc(names[id] || "someone")}</span>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<()]+[^\s<.,;:!?)])/g,
      (m, label, named, bare) => `<a href="${named || bare}" style="color:#5b4eb0">${label || bare}</a>`);
  const out = []; let list = false;
  for (const line of String(text || "").split("\n")) {
    const li = line.match(/^\s*[-•*]\s+(.*)$/);
    if (li) { if (!list) { out.push('<ul style="margin:4px 0;padding-left:20px">'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const hd = line.match(/^#{1,3}\s+(.*)$/);
    if (hd) out.push(`<div style="color:#b3263e;font-weight:700;margin-top:8px">${inline(hd[1])}</div>`);
    else if (!line.trim()) out.push('<div style="height:8px"></div>');
    else out.push(`<div>${inline(line)}</div>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

async function buildEmail(post, postId, place, authorName, authorEmail) {
  const ids = [...new Set((String(post.body || "").match(/<@([A-Za-z0-9_-]+)>/g) || []).map((t) => t.slice(2, -1)))];
  const names = {};
  await Promise.all(ids.map(async (id) => { names[id] = await nameOf(id); }));
  const label = post.priority === "urgent" ? "URGENT" : post.priority === "important" ? "Important" : "";
  const badge = label ? `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:${post.priority === "urgent" ? "#fbecee;color:#b3263e" : "#fbf1e1;color:#a8670e"}">${label}</span>` : "";
  const link = `${APP_URL}/#post-${postId}`;
  const subject = `${label ? label + ": " : ""}${post.subject || clip(plain(post.body), 70) || "New post"} [${place}]`;
  const html = `<!doctype html><html><body style="margin:0;background:#f0ede6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:20px 12px">
<div style="background:#1a1a1a;border-bottom:3px solid #c9a84c;padding:14px 20px;border-radius:12px 12px 0 0">
<div style="font-size:10px;letter-spacing:.3em;color:#c9a84c;text-transform:uppercase">Enchanted Medical Aesthetics</div>
<div style="font-family:Georgia,serif;font-size:22px;color:#c9a84c">Staff Hub</div></div>
<div style="background:#fff;border:1px solid #ddd8ce;border-top:0;border-radius:0 0 12px 12px;padding:20px">
<div style="font-size:13px;color:#6b6357;margin-bottom:8px">${esc(authorName)} posted in <strong>${esc(place)}</strong> ${badge}</div>
${post.subject ? `<h2 style="margin:6px 0 10px;font-size:20px">${esc(post.subject)}</h2>` : ""}
<div style="font-size:15px;line-height:1.6">${postHtml(post.body, names)}</div>
${(post.attachments || []).length ? `<div style="margin-top:10px;font-size:13px;color:#6b6357">📎 ${post.attachments.length} attachment${post.attachments.length > 1 ? "s" : ""} in the post</div>` : ""}
<div style="margin-top:20px"><a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${post.priority === "update" ? "Open in Staff Hub" : "Open and acknowledge"}</a></div>
</div>
<p style="font-size:11.5px;color:#6b6357;margin:14px 4px;line-height:1.5">You're getting this because you're on the Enchanted Staff Hub. To change which emails you get, open Staff Hub → ⚙ My settings. Replies go to ${esc(authorName)}. Please don't include patient information.</p>
</div></body></html>`;
  const text = `${authorName} posted in ${place}${label ? " (" + label + ")" : ""}\n\n${post.subject ? post.subject + "\n\n" : ""}${String(post.body || "").replace(/<@([A-Za-z0-9_-]+)>/g, (m, id) => "@" + (names[id] || "someone")).replace(/\*\*([^*\n]+)\*\*/g, "$1")}\n\nOpen in Staff Hub: ${link}\n\nTo change which emails you get, open Staff Hub > My settings.`;
  return { subject, html, text, replyTo: authorEmail || undefined };
}

// Email one person if they want this kind of alert.
async function emailTo(uid, msg, force) {
  if (!mailOn() || !msg.email) return false;
  const u = (await db.doc(`users/${uid}`).get()).data();
  if (!u || !u.email) return false;
  const pref = u.emailNotify || "all";
  const wanted = force || (msg.level !== "reply" && pref === "all") || msg.mentioned
    || (pref === "important" && (msg.level === "urgent" || msg.level === "important"));
  if (!wanted || (pref === "off" && !force)) return false;
  await mailer().sendMail({
    from: `"Enchanted Staff Hub" <${MAIL.user}>`, to: u.email, replyTo: msg.email.replyTo,
    subject: msg.email.subject, html: msg.email.html, text: msg.email.text,
  });
  return true;
}

async function notifyNow(uid, msg) {
  const results = await Promise.allSettled([msg.push === false ? 0 : pushTo(uid, msg), emailTo(uid, msg)]);
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
  if (!post || post.imported) return; // posts brought over from Teams don't notify anyone
  const postId = event.params.postId;
  const [place, author, people] = await Promise.all([where(post), nameOf(post.author), audience(post.group || "all", post.author)]);
  const important = post.priority === "important" || post.priority === "urgent";
  const label = post.priority === "urgent" ? "URGENT · " : post.priority === "important" ? "Important · " : "";
  const text = clip(`${author}: ${post.subject ? post.subject + " — " : ""}${plain(post.body)}`, 180);
  const link = `/#post-${postId}`;
  const authorEmail = ((await db.doc(`users/${post.author}`).get()).data() || {}).email;
  const email = mailOn() ? await buildEmail(post, postId, place, author, authorEmail) : null;
  await Promise.all(people.map((u) => {
    const mentioned = (post.mentions || []).includes(u.id);
    const pushOk = wants(u, { important, mentioned });
    const mailPref = u.emailNotify || "all";
    const mailOk = !!email && mailPref !== "off" && (mailPref === "all" || important || mentioned);
    if (!pushOk && !mailOk) return null;
    const msg = {
      title: mentioned ? `${author} mentioned you · ${place}` : `${label}${place}`, body: text, link, tag: `post-${postId}`,
      urgent: post.priority === "urgent", level: post.priority || "update", mentioned, push: pushOk, email: mailOk ? email : null,
    };
    // Everything waits for the person's next shift if they're off, unless an urgent post is sent to everyone.
    return deliver(u, msg, { force: post.priority === "urgent" && post.reachAll === true, holdIfOff: true, key: `post-${postId}` });
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
  if (reply.imported) return;

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
      body: clip(plain(reply.body), 180), link, tag: `post-${postId}`, level: "reply", mentioned, email: null,
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
  let email = null;
  if (mailOn()) {
    const a = (await db.doc(`users/${post.author}`).get()).data() || {};
    email = await buildEmail(post, postId, place, a.name || "A manager", a.email);
    email.subject = `Reminder, please acknowledge: ${email.subject}`;
  }
  const msg = {
    title: `Please acknowledge · ${place}`, body: clip(post.subject || plain(post.body), 180), link: `/#post-${postId}`, tag: `post-${postId}`,
    level: post.priority || "important", mentioned: false, email,
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

// Recreate saved Teams posts (functions/import/teams-posts.json) with their original authors, dates and replies.
// Authors are linked to staff accounts by name when one exists; otherwise their name is shown as written.
exports.importTeamsPosts = onCall(async (req) => {
  const me = await requireUser(req, true);
  const users = (await db.collection("users").get()).docs.map((d) => ({ id: d.id, name: String(d.get("name") || "").trim().toLowerCase() }));
  const uidFor = (name) => (users.find((u) => u.name && u.name === String(name).trim().toLowerCase()) || {}).id || null;
  // "__owner__" marks something the person running the import wrote themselves ("You" in Teams).
  const who = (name) => { if (name === "__owner__") return { author: me.id }; const id = uidFor(name); return id ? { author: id } : { author: me.id, displayAuthor: name }; };
  const comms = (await db.collection("communities").get()).docs;
  const chans = (await db.collection("channels").get()).docs;
  let posts = 0, replies = 0, skipped = 0;
  const missing = new Set();
  for (const item of TEAMS_POSTS) {
    const done = await db.collection("posts").where("importKey", "==", item.key).limit(1).get();
    if (!done.empty) { skipped++; continue; }
    const c = comms.find((d) => d.get("name").toLowerCase() === item.community.toLowerCase());
    const ch = c && chans.find((d) => d.get("communityId") === c.id && (item.channel === "General" ? d.get("general") : d.get("name").toLowerCase() === item.channel.toLowerCase()));
    if (!ch) { missing.add(`${item.community} › ${item.channel}`); continue; }
    const ref = db.collection("posts").doc();
    await ref.set(Object.assign({
      channelId: ch.id, communityId: c.id, group: ch.get("group") || "all",
      subject: item.subject || "", body: item.body || "", priority: item.priority || "update", mentions: [],
      attachments: item.attachments || [], pinned: !!item.pinned, reachAll: false, acks: {}, reactions: {}, replyCount: 0,
      createdAt: Date.parse(item.at), imported: true, importKey: item.key,
    }, who(item.author)));
    posts++;
    for (const r of item.replies || []) {
      const mentionIds = [];
      const tags = (r.mentions || []).map((n) => { const id = uidFor(n); if (id) { mentionIds.push(id); return `<@${id}>`; } return `**@${n}**`; });
      await ref.collection("replies").add(Object.assign({
        body: tags.length ? `${r.body} ${tags.join(" ")}` : r.body, mentions: mentionIds, createdAt: Date.parse(r.at), imported: true,
      }, who(r.author)));
      replies++;
    }
  }
  return { posts, replies, skipped, missing: [...missing] };
});

exports.emailStatus = onCall(async (req) => {
  await requireUser(req, false);
  return { enabled: mailOn() };
});

exports.sendTestEmail = onCall(async (req) => {
  const me = await requireUser(req, false);
  if (!mailOn()) throw new HttpsError("failed-precondition", "Email alerts aren't switched on yet.");
  const email = await buildEmail({ subject: "Email alerts are working", body: "You'll get emails like this when something is posted in the **Staff Hub**.", priority: "update" }, "", "Test", "Staff Hub", MAIL.user);
  email.subject = "Test: Staff Hub email alerts are working";
  await emailTo(me.id, { level: "update", email }, true);
  return { sent: true, to: me.email };
});

exports.sendQueued = onSchedule({ schedule: "every 10 minutes", timeZone: sched.TZ }, async () => {
  const due = await db.collection("queue").where("dueAt", "<=", Date.now()).limit(300).get();
  for (const d of due.docs) {
    const { uid, msg } = d.data();
    const u = (await db.doc(`users/${uid}`).get()).data();
    if (u && u.active && !sched.isPaused(u.schedule, Date.now())) {
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
