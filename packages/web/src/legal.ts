/**
 * Privacy Policy and Terms of Service. Static text, so no escaping is needed. Keep the list
 * of service providers in step with what the system actually uses (voice/, packages/apps).
 * Drafts for counsel to review before public launch.
 */

export const LEGAL_EFFECTIVE = "October 27, 2026";

const h = (title: string, body: string) => `<h2>${title}</h2>${body}`;

export function privacyPage(): string {
  return (
    `<article class="legal"><h1>Privacy policy</h1><p class="muted">Effective ${LEGAL_EFFECTIVE}</p>` +
    `<p>Kloru is an assistant for groups: families, friends and the people you plan things with. This policy explains what we collect, why, who helps us run Kloru, and the choices you have. "Kloru", "we" and "us" mean the operator of kloru.com. Questions go to <a href="mailto:privacy@kloru.com">privacy@kloru.com</a>.</p>` +
    h(
      "What we collect",
      `<ul>` +
        `<li><strong>Your account.</strong> Your phone number, your name if you give it, the groups you belong to, and the people your group adds.</li>` +
        `<li><strong>What you send Kloru.</strong> Texts, and calls to your group's Kloru number. Calls are turned into text as they happen so Kloru can understand and answer; we keep the text of the conversation for 90 days so we can check and improve Kloru's work, unless you turn off "Help improve Kloru for everyone" in Settings. We do not keep recordings of calls.</li>` +
        `<li><strong>Apps you connect.</strong> If you connect an app such as Google Calendar or Gmail, Kloru reads and acts in it only to do what you or your group ask, within the permissions you set. We keep what a task needs (for example, the event it created), not a copy of your mailbox or calendar.</li>` +
        `<li><strong>What Kloru remembers.</strong> Notes, preferences and plans that make the next request easier ("we're vegetarian", "Saturdays are for soccer"). You can see and remove these.</li>` +
        `<li><strong>Approvals and activity.</strong> Which actions were asked for, approved or denied, and a log of what Kloru did, so you can check its work.</li>` +
        `<li><strong>Technical data.</strong> Your network address and the cookies that keep you signed in and protect forms. We do not use advertising or tracking cookies.</li>` +
      `</ul>`,
    ) +
    h(
      "How we use it",
      `<p>To run Kloru for you and your group: answer and act on requests, text sign-in codes, keep your account secure, prevent abuse, and fix problems. We do not sell your personal information, and we do not share it for advertising. We do not use your conversations or app data to train AI models.</p>`,
    ) +
    h(
      "Who helps us run Kloru",
      `<p>We use these service providers. Each receives only what it needs to do its job for us, under contract, and may not use it for its own purposes.</p><ul>` +
        `<li><strong>Twilio</strong>: phone numbers, calls, texts and sign-in codes.</li>` +
        `<li><strong>Deepgram</strong>: turning speech on calls into text.</li>` +
        `<li><strong>Cartesia</strong>: turning Kloru's replies into speech.</li>` +
        `<li><strong>OpenRouter</strong>, and the AI model providers it routes to: understanding requests and writing replies.</li>` +
        `<li><strong>Composio</strong>: secure connections to the apps you choose to connect.</li>` +
        `<li><strong>Google</strong>: Google Workspace apps you connect, such as Calendar and Gmail.</li>` +
        `<li><strong>Fly.io</strong>: the servers that run Kloru, in the United States.</li>` +
        `<li><strong>Neon</strong>: the database that holds accounts and group membership.</li>` +
        `<li><strong>Cloudflare</strong>: kloru.com's domain records, and encrypted backups and files.</li>` +
        `<li><strong>Langfuse</strong>: measuring how calls go (timing, silences, and, if "Help improve Kloru for everyone" is on, what was said) so we can find and fix problems.</li>` +
      `</ul>`,
    ) +
    h(
      "Google user data",
      `<p>Kloru's use of information received from Google APIs follows the Google API Services User Data Policy, including its Limited Use requirements. We use Google data only to provide features you request, we do not transfer it except as needed to provide those features, for security, or as required by law, we do not use it for advertising, and people at Kloru do not read it unless you ask us to, it is needed for security, or the law requires it.</p>`,
    ) +
    h(
      "Inside your group",
      `<p>Kloru shares information within a group according to the permissions your group sets. For example, a family member may be able to see when you're free without seeing your events. Group admins choose these permissions and can change them at any time.</p>`,
    ) +
    h(
      "Children",
      `<p>Kloru accounts are for adults 18 and over. A parent or guardian may add their children to a family group and tell Kloru about them (for example, practice schedules) and is responsible for what they share. Children under 13 should not text or call Kloru themselves. If you believe a child under 13 has given us information directly, write to <a href="mailto:privacy@kloru.com">privacy@kloru.com</a> and we will delete it.</p>`,
    ) +
    h(
      "How long we keep it",
      `<p>We keep your information while your account is active. You can disconnect apps and remove what Kloru remembers at any time. When you ask us to delete your account, we delete your information within 30 days, except what the law requires us to keep; copies in backups expire within 30 days after that. To protect your account from callers faking your number, we keep a log of calls to Kloru numbers (the calling number, time and what Kloru did) for 90 days; we do not record calls.</p>`,
    ) +
    h(
      "Your choices and rights",
      `<p>You can see, correct, export or delete your information by writing to <a href="mailto:privacy@kloru.com">privacy@kloru.com</a> from your account's phone number or with enough detail for us to verify you. Depending on where you live, including California, you have rights to know what we collect, to correct and delete it, and not to be treated differently for using these rights. We do not sell or share personal information as California law defines those terms. Reply STOP to any Kloru text to stop texts.</p>`,
    ) +
    h(
      "Text messages",
      `<p>We use your phone number to text you sign-in codes and messages about the tasks you or your group ask Kloru to do. Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes. Information is shared with the service providers above only to deliver Kloru, such as sending texts through Twilio. All of the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.</p>`,
    ) +
    h(
      "Security",
      `<p>Information is encrypted in transit. Access is limited to the people and systems that need it, sign-in uses one-time codes, and connections to your apps use their own secure authorization so we never see your app passwords. No system is perfectly secure; if something goes wrong that affects you, we will tell you.</p>`,
    ) +
    h(
      "Changes",
      `<p>If we change this policy in a way that matters, we will tell you before the change takes effect, by text or on this page.</p>`,
    ) +
    `<p>Contact: <a href="mailto:privacy@kloru.com">privacy@kloru.com</a></p></article>`
  );
}

export function termsPage(): string {
  return (
    `<article class="legal"><h1>Terms of service</h1><p class="muted">Effective ${LEGAL_EFFECTIVE}</p>` +
    `<p>These terms are an agreement between you and Kloru ("Kloru", "we", "us") about your use of Kloru, including kloru.com, the Kloru phone numbers and the Kloru assistant. By using Kloru you agree to these terms and to our <a href="/privacy">Privacy Policy</a>. Questions go to <a href="mailto:legal@kloru.com">legal@kloru.com</a>.</p>` +
    h(
      "Who can use Kloru",
      `<p>You must be 18 or older and able to agree to these terms. A parent or guardian may add their children to a family group and is responsible for their use of Kloru. Kloru is invite only for now.</p>`,
    ) +
    h(
      "Your account and your group",
      `<p>You sign in with your phone number and are responsible for activity on your account. Group admins decide who is in the group and what Kloru may do for each member, and are responsible for those choices. Only add people who agree to be added.</p>`,
    ) +
    h(
      "What Kloru does for you",
      `<p>Kloru acts on your behalf: it can read and change the apps you connect, place orders, make plans and send messages, within the permissions you set. Actions set to "Ask me first" wait for your approval. You are responsible for the actions you approve and for the permissions you grant. Kloru uses AI and can make mistakes; check anything important, especially purchases, bookings and messages to others.</p>`,
    ) +
    h(
      "Purchases and other services",
      `<p>When Kloru buys something or books something for you, the purchase is between you and the seller, under the seller's terms. Apps you connect are governed by their own terms. Kloru is not responsible for third-party products, services or apps.</p>`,
    ) +
    h(
      "Kloru text messages",
      `<p>When you ask for a sign-in code on kloru.com, we text a one-time code to that number. Texts about your tasks are optional: you get them only if you tick the separate box when you sign in, or text Kloru first, and you can use Kloru without them. They are messages about the tasks you or your group ask Kloru to do, such as plan updates, reminders and results. Message frequency varies. Message and data rates may apply. Reply STOP to any message to opt out; you will get one text confirming it and no more after that. Reply HELP for help, or write to <a href="mailto:support@kloru.com">support@kloru.com</a>. Carriers are not liable for delayed or undelivered messages. Agreeing to receive texts is not a condition of using Kloru or of any purchase. See the <a href="/privacy">Privacy Policy</a> for how we handle your number.</p>`,
    ) +
    h(
      "Acceptable use",
      `<p>Don't use Kloru to break the law, harass or deceive anyone, send spam, reach people who haven't agreed to hear from you, access accounts that aren't yours, or interfere with Kloru or the services it uses. We may limit or suspend accounts that do.</p>`,
    ) +
    h(
      "Fees",
      `<p>Kloru is free during the invite-only period. If we introduce fees, we will tell you the price before you are charged, and you can decide whether to continue.</p>`,
    ) +
    h(
      "Your content and ours",
      `<p>Your messages and data stay yours. You give us permission to use them only to provide and improve the reliability of Kloru for you, as described in the Privacy Policy. Kloru's software, name and design are ours. If you send us feedback, we may use it without obligation to you.</p>`,
    ) +
    h(
      "Ending",
      `<p>You can stop using Kloru and ask us to delete your account at any time. We may suspend or end access if you break these terms or if we stop offering Kloru, and we will try to give you notice and a chance to export your information.</p>`,
    ) +
    h(
      "Disclaimers",
      `<p>Kloru is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement, and we do not promise that Kloru will be uninterrupted, error-free, or that its results will be accurate.</p>`,
    ) +
    h(
      "Limitation of liability",
      `<p>To the fullest extent the law allows, Kloru will not be liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, data or goodwill, and our total liability for any claim about Kloru is limited to the greater of $100 or what you paid us in the 12 months before the claim. Some places don't allow these limits, so they may not apply to you.</p>`,
    ) +
    h(
      "Indemnity",
      `<p>If you use Kloru in a way that breaks these terms or the law and someone makes a claim against us because of it, you agree to cover our reasonable costs of that claim.</p>`,
    ) +
    h(
      "Law and disputes",
      `<p>These terms are governed by the laws of the State of California, without regard to its conflict-of-law rules. Any dispute will be resolved in the state or federal courts located in Santa Clara County, California, and you and we consent to their jurisdiction.</p>`,
    ) +
    h(
      "Changes",
      `<p>We may update these terms. If a change matters, we will tell you before it takes effect; continuing to use Kloru after that means you accept the new terms.</p>`,
    ) +
    `<p>Contact: <a href="mailto:legal@kloru.com">legal@kloru.com</a></p></article>`
  );
}
