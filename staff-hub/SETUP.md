# Enchanted Staff Hub

A Teams-style app for office updates: communities and channels, posts with @mentions, photos, reactions,
replies, **Acknowledge** with "Seen by" and "Not yet" lists, and push notifications that respect each
person's work days and hours (Florida time). Staff install it on their phones from the browser. No app
store and no per-person fees.

Patient information does not go here. Use Weave Team Chat for patient follow-ups.

## How it's built

| Part | Where |
|---|---|
| App people use (`public/`, `web/src/`) | Firebase Hosting, at `https://<project-id>.web.app` |
| Logins | Firebase Authentication (email + password, invite only) |
| Posts, channels, staff | Cloud Firestore, protected by `firestore.rules` |
| Photos and PDFs | Cloud Storage, protected by `storage.rules` |
| Notifications, quiet hours, invites, reminders (`functions/`) | Cloud Functions |

Pushing changes under `staff-hub/` runs `.github/workflows/staff-hub.yml`, which builds the app and
deploys everything to Firebase.

## One-time setup (about 30 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and sign in with the office Google account.
2. **Create a project** named `enchanted-staff-hub` (Firebase may add numbers to the ID; note the final **Project ID**).
3. Google Analytics: turn it **off**. Create the project.
4. Bottom left, **Upgrade** to the **Blaze (pay as you go)** plan and add a card.
   Set a budget alert of **$5/month** when it asks. Expected cost for a team of ~20 is $0–2/month.

### 2. Turn on the pieces the app uses
1. **Build → Firestore Database → Create database.** Location: **nam5 (United States)**. Start in **production mode**.
2. **Build → Storage → Get started.** Accept the defaults, same US location.
3. **Build → Authentication → Get started → Email/Password → Enable → Save.**
4. Authentication → **Settings → User actions**: **uncheck "Enable create (sign-up)"**, so only invited people can get accounts.
5. Authentication → **Users → Add user**: your email (`info@enchantedmedicalaesthetics.com`) and a password. This is the owner account.

### 3. Register the web app
1. **Project Overview → Add app → Web (`</>`)**.
2. Nickname: `Staff Hub`. Check **Also set up Firebase Hosting**. **Register app**, then click **Continue to console** (skip the code steps).

### 4. Create the notification key
1. ⚙ **Project settings → Cloud Messaging** tab.
2. Under **Web configuration → Web Push certificates**, click **Generate key pair**.
3. Copy the long key that appears. This is the **VAPID key**.

### 5. Create the deploy key
1. ⚙ **Project settings → Service accounts → Generate new private key → Generate key.** A `.json` file downloads.
2. Open <https://console.cloud.google.com/iam-admin/iam>, pick the same project.
3. Find the account that starts with `firebase-adminsdk-…`, click the ✏️ pencil, **Add another role → Owner → Save**.
   (Deploying notifications and scheduled reminders needs broad permissions. The key is stored only as an encrypted GitHub secret.)

### 6. Add the secrets to GitHub
In the repository: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Name | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | the Project ID from step 1 |
| `FIREBASE_SERVICE_ACCOUNT` | the **entire contents** of the `.json` file from step 5 |
| `FIREBASE_VAPID_KEY` | the key from step 4 |
| `HUB_OWNER_EMAILS` *(optional)* | owner emails, comma separated (default `info@enchantedmedicalaesthetics.com`) |

### 7. Deploy
**Actions → Deploy Staff Hub → Run workflow** (or re-run the latest run). When it finishes, the summary shows the
app's address: `https://<project-id>.web.app`.

### 8. First sign-in
1. Open the address, sign in with the owner account from step 2.
2. Tap **Load our communities** to create your communities and channels.
3. Tap 👥 **Team → Invite staff** for each person. They get an email to set a password.
4. ⚙ **My settings → Turn on notifications**.

Optional: Authentication → **Templates → Password reset**, set the sender name to "Enchanted Staff Hub" and the
subject to "Set your Staff Hub password".

## Text message alerts (optional)

Staff who opt in under **My settings → Text messages** get a text for urgent alerts (or important and urgent,
their choice), following their work schedule. Texts go out through **Twilio**. Texting stays off until these
three repository secrets exist:

| Name | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account Info → Account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info → Auth Token |
| `TWILIO_FROM` | the approved toll-free number in `+18885551234` form, or a Messaging Service SID (`MG…`) |

US carriers require the number to be verified before it can text: use a **toll-free number** and submit
**Toll-Free Verification** in Twilio. The opt-in proof is the Text messages screen in the app plus
`https://<project-id>.web.app/sms-terms.html`. After adding the secrets, re-run the deploy workflow.

## Installing on phones

**iPhone / iPad** (iOS 16.4 or newer): open the address in **Safari** → **Share** → **Add to Home Screen** → open
Staff Hub from the new icon → ⚙ My settings → **Turn on notifications** → Allow.

**Android**: open the address in **Chrome** → menu ⋮ → **Install app** (or Add to Home screen) → open it →
⚙ My settings → **Turn on notifications** → Allow.

## How notifications work

- New posts notify everyone who can see the channel (each person can choose all posts, only important, or nothing).
- Notifications only arrive during a person's work days and hours. **Important** and **Urgent** posts and @mentions
  that arrive while someone is off are delivered at the start of their next shift (checked every 10 minutes).
  Plain updates posted while someone is off are not sent; they show as unread.
- On an **Urgent** post the author can tick "Notify people who are off too".
- Managers can tap **Not yet** under an important post to see who hasn't acknowledged and **Remind them**.

## Local development

```
cd staff-hub/web && npm ci && npm run build
cd ../functions && npm ci
npx firebase-tools emulators:start --project demo-staffhub
```
Then open <http://127.0.0.1:5000/?emulators>.
