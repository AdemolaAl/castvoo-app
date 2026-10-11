'use strict';
/*
 * Castvoo's starting knowledge, read by Cas (the in-app helper), the 24/7 AI support team and the website chat.
 * The team edits and adds to it in Admin → Cas knowledge.
 *
 * Every default has a `key`. On each start seed.js syncKnowledge() inserts new defaults and updates the ones the
 * team never edited. An article edited in the admin is never overwritten, and a deleted default never comes back.
 * So: to change a default, edit it here (keep its key). To retire one, remove it here and add its key to RETIRED
 * at the bottom: a row nobody edited is then removed on the next start (an edited one stays until the team deletes it).
 * `formerly` lists older titles of the same article, so a database made before keys existed adopts the old row.
 *
 * Rules: short, true and specific. Only what really works (docs/PRODUCT-FACTS.md). Name the exact page and
 * button. NO plan prices or per-plan limits here: the agents read them live from the plans table
 * (services/ai.js plansText: prices, connections, subscribers, join requests, flows, steps per flow, AI writes,
 * seats, features and the trial), so pricing changes in Admin → Pricing are always right. Product rules that are
 * not numbers in the plans table (the Free welcome's Castvoo line, what one Free welcome may contain) are written here.
 */
module.exports = [
  /* =========================== Getting started =========================== */
  { key: 'what-castvoo-is', title: 'What Castvoo is', body: `Castvoo sends Telegram messages for businesses and creators. It connects to a Telegram bot, channel or group and lets you:
- welcome everyone who asks to join your channel or group, let them in and follow up later (Welcome Flows)
- send a message now, later, or at the next 9am in the workspace time zone (the owner sets it in Settings to where their audience lives; Castvoo does not know each subscriber's own time zone)
- set up auto follow-ups that send themselves after someone starts the bot, uses a start link, or gets a tag
- send to an audience (part of your bot subscribers)
- add buttons with tracked links and see who clicked
- write, rewrite and translate messages with Cas, the AI helper
There is a Free plan (a welcome bot for one channel or group) and paid plans; see the live plan list.
Castvoo is made by Zedapex in Lagos. It is independent and not affiliated with Telegram. Support is answered 24/7 in the dashboard Help chat by AI support agents, with the human team as back-up.` },

  { key: 'getting-started', title: 'Getting started in 5 minutes', body: `1. Sign up at castvoo.com (email code, Telegram or VooSquare). Pick your country: it decides which payment methods you see.
2. Connect Telegram: Channels & bots → Add a bot (paste a token from @BotFather) or Add a channel / Add a group (one tap, adds @CastvooBot as admin).
3. Send your first message: Send a message → pick where it goes → write it → Send now.
4. Set up a welcome: for a channel or group that uses join requests, Welcome Flows → pick a template → switch it on. For people who press Start on your bot, Auto follow-ups → New → trigger "Someone presses Start" → first message with wait 0 minutes.
5. Teach Cas your business: Ask Cas → Train Cas (two minutes), so its writing sounds like you.
Video help: the Guides page in the dashboard menu has 10 short voiced videos (about a minute each) that show these steps in the real dashboard. The castvoo.com website also has a 40-second setup animation (the "Watch the 40-second setup" button).` },

  { key: 'video-guides', title: 'Video guides (the Guides page)', body: `The dashboard menu has a Guides page with 13 short video tutorials. Each one shows the real dashboard step by step, with a voice-over and captions, and lasts about 70 to 105 seconds:
1. Connect your Telegram bot (guide id connect-bot; making a bot with @BotFather and pasting its token)
2. Add a channel or group (add-channel; linking your Telegram, then connecting in one tap)
3. Build a welcome bot with Cas (cas-builder; a Welcome bot for people who ask to join your channel: tap a goal like "Offer VIP 💎", your topic and your link, "✨ Just build it for me", see it play, send a test to your Telegram, switch it on; change anything later by typing. It was filmed before the 🤖 Bots menu: today you start it with 🤖 Bots → New bot → 👋 Welcome bot)
4. Build a welcome bot yourself (welcome-flow; the builder: the welcome with {name} and a Tap Start button, "When should the next message come?" (⚡ Right away, 👆 When they tap Start, 💤 If they don't respond in 10 minutes, 🔘 When they tap a button), a Link and a Reply button, 👁 Preview this step, ▶ Preview the whole flow, 📲 Send a test to my Telegram, then switch it on)
5. Build any bot with Cas (bots-with-cas; a Chat bot: 🤖 Bots → New bot → 💬 Chat bot → Build it with Cas → "Make people join my channel first", pick the channel, the free gift link and a 10-minute reminder; ▶ See it play with "🙈 Not yet" and "I've joined ✅", switch it on, then copy the start link. Cas also builds free gift, menu, questions and invite-friends bots)
6. Build a bot yourself (bots-yourself; New bot → 💬 Chat bot → the "Free gift from my ad" template: change the words, the gift link, a second button, when the next message comes, delete a message, the special step "❓ Ask a question" with an Email answer, move it up, ▶ Preview the whole bot with a typed answer, 📲 Send a test to my Telegram, save, switch it on, Copy the link)
7. Leads, invites & broadcasts (bots-leads-invites; a questions bot's Leads tab and Download CSV (Starter plan and up), an invite-friends bot with its Invites leaderboard (Growth plan and up; only people new to the bot count), and 📣 Broadcast to these people, which opens Send a message with the audience "Started <bot name>")
8. Send a broadcast (send-broadcast; {name}, buttons and scheduling)
9. Auto follow-ups (auto-follow-ups; messages your bot sends by itself, on a timer)
10. Audiences & start links (audiences-start-links; which ad brought each subscriber, then message just them)
11. Wallet, plans & the Free plan (wallet-plans; top up, pick a plan, what happens on Free)
12. Earn with referrals & get help (referrals-help; your link, monthly earnings, and 24/7 support chat)
13. Invite a setup helper (setup-helper; let your media buyer or a friend set things up with their own login, no password sharing)
Pages with a guide also show a "Watch the guide" button at the top (for example Channels & bots, Send a message, Wallet). 🤖 Bots shows five: "Welcome bot with Cas", "Welcome bot yourself", "Chat bot with Cas", "Chat bot yourself" and "Leads & invites". The Welcome bot chooser has small "▶ Watch how" links for the two welcome guides, and Cas Builder's "Watch the guide" button plays Build any bot with Cas. The castvoo.com homepage ("See it work") plays Build a welcome bot with Cas, Build a welcome bot yourself, Connect your Telegram bot and Send a broadcast. The setup helper guide is on the Setup helper card in Settings → Team and on the "Get help setting up" cards. The player has play/pause, speed (0.75× to 1.75×), captions on or off (CC) and full screen. Watched guides get a tick; the ticks are saved in that browser only. The Help page has a "Watch the video guides" link too. Support can send any of these as a card that plays the guide right away (share_link guide:<id>).` },

  { key: 'bots-channels-groups', title: 'Bots, channels and groups: the difference', body: `- Bot: people press Start on your bot. Castvoo can message each person one by one, so audiences, follow-ups, {name} and per-person click tracking work.
- Channel: a post goes to everyone in the channel. Bots cannot see channel members, so you cannot pick part of a channel. You see the member count, and clicks as totals.
- Group: like a channel, a message goes to the whole group chat.
Best setup for most businesses: a channel for public posts plus a bot that collects people for personal follow-ups. Put a button in channel posts that opens your bot.
Channel and group members do not count toward the plan's subscriber limit; only people who started your bots do.` },

  /* =========================== Connecting =========================== */
  { key: 'connect-bot', title: 'How to connect a bot', body: `1. In Telegram, open @BotFather and send /newbot.
2. Pick a name and a username ending in "bot".
3. BotFather replies with a token like 123456789:AA... Copy all of it.
4. In Castvoo: Channels & bots → Add a bot → paste the token → Connect.
Castvoo checks the token with Telegram and points the bot's webhook at Castvoo, so it starts listening at once. Only the workspace owner can connect or remove bots.
One bot can only be connected to one Castvoo workspace at a time. Never share your bot token with anyone (Castvoo staff will never ask for it in chat).
Pasting a new token for a bot that is already connected (for example after /revoke) keeps its subscribers, follow-ups and stats.` },

  { key: 'connect-channel', title: 'How to connect a channel or group', body: `In Castvoo: Channels & bots → Add a channel (or Add a group) → tap "Add @CastvooBot". Telegram opens, you pick your channel or group and approve the admin rights. Castvoo connects it within a few seconds and @CastvooBot sends you a "connected" message.
Your Telegram account must be linked first (sign in with Telegram, or Settings → Link Telegram) so Castvoo knows the channel is yours. The link from Castvoo works for 30 minutes.
Rights @CastvooBot needs: channels: Post messages (and Edit and Delete if you want to edit or delete posts from Castvoo). Groups: it must be an admin (Delete and Pin to delete or pin).
For Welcome Flows (join-request welcomes), your OWN bot (not @CastvooBot) must also be an admin of the channel with the "Add members" (invite users) right. @CastvooBot never sends welcomes.` },

  { key: 'connection-errors', formerly: ['Troubleshooting'], title: 'Connection error messages and how to fix them', body: `- "That doesn't look like a bot token": copy the whole token again from @BotFather. It looks like 123456789:AAH... with no spaces.
- "Telegram says this token is not valid": the token was revoked or mistyped. In @BotFather send /token (or /revoke) for a fresh one and paste it.
- "That token is not for a bot": paste a token from @BotFather, not your own account details.
- "@yourbot is already connected to another Castvoo workspace. Remove it there first.": one bot works in one workspace. Remove it in the other workspace (Channels & bots → Remove), or log in to that account.
- "That token belongs to a different bot": you pasted the token of another bot while reconnecting. Use the token of the bot shown.
- "Telegram did not accept the connection: ...": Telegram refused the webhook. Wait a minute and try again. If it keeps happening, tell support.
- "Could not reach Telegram. Please try again in a minute.": Telegram was briefly unreachable. Try again.
- "Your plan allows N connections. Upgrade to add more.": remove a connection you no longer use, or upgrade in Wallet and plan.
- "Link your Telegram account first, so Castvoo knows the channel is yours.": Settings → Link Telegram → tap the link → Yes, link it. Then add the channel again.
- "This chat is already connected to another Castvoo workspace": remove it from the other workspace first, then add @CastvooBot again.
- @CastvooBot says "I couldn't find a Castvoo account linked to your Telegram": link Telegram in Settings with the same Telegram account you used to add the bot, then add it again.
- "Channel connections are not set up yet on this server": the team must finish setup; tell support.
- A bot or channel shows "Needs attention": open Channels & bots. For a bot, paste a fresh token from @BotFather (subscribers are kept). For a channel or group, add @CastvooBot as admin again with Post messages.` },

  { key: 'needs-attention', title: '"Needs attention" and lost admin rights', body: `A connection turns to "Needs attention" when Castvoo can no longer use it:
- "The bot token stopped working. Reconnect the bot.": the token was revoked in @BotFather. Paste the new token in Channels & bots → Add a bot. Subscribers, follow-ups and stats stay.
- "Castvoo can no longer post here. Add @CastvooBot as admin again.": @CastvooBot was removed from the channel or group, or lost "Post messages". Add it again from Channels & bots.
- "Castvoo was removed from this chat or lost its admin rights": same fix.
Another tool taking over your bot (setting its own webhook) also stops Castvoo hearing new subscribers. Support can re-point the webhook to Castvoo for you, or you can paste the token again.` },

  { key: 'link-telegram', title: 'Linking your Telegram account', body: `Settings → Link Telegram (or sign in with Telegram). Castvoo opens @CastvooBot with a private link; tap Start, then "Yes, link it". The link works for 15 minutes; if it expired, tap Link Telegram again.
Linking lets you add channels and groups in one tap and receive test messages. One Telegram account can be linked to one Castvoo login.
"This Telegram account is already linked to another Castvoo login": log in to that other account, or unlink it there first.` },

  /* =========================== Sending =========================== */
  { key: 'sending', title: 'Sending a message', body: `Send a message → choose where it goes → choose who gets it (bots only) → write it → add a photo or video if you want → add buttons → choose Send now, Schedule or 9am local time → Send.
Before sending you see how many people it will reach and roughly how long it takes.
Send a test first: the test goes to your own Telegram (link Telegram in Settings). If it says "Open @yourbot in Telegram and press Start once, then try the test again", open your bot and press Start, then test again.
Formatting: *bold* with stars, _italic_ with underscores.` },

  { key: 'personal-name', title: 'Personal messages with {name}', body: `Write {name} (or tap "👤 Name") and each bot subscriber sees their own Telegram first name: "Hi {name}!" becomes "Hi Tunde!".
If Castvoo has no name for someone, or the message goes to a channel or group, {name} becomes "there". Choose your own fallback word with {name|friend}. {first_name} works too.
Names are cut to 20 characters. Works in broadcasts and auto follow-ups. Do not invent other placeholders: only {name} is filled in.` },

  { key: 'scheduling', title: 'Scheduling and time zones', body: `- Send now: starts straight away.
- Schedule: pick a date and time, up to 90 days ahead. Errors: "That time has already passed" (pick a later time), "You can schedule up to 90 days ahead".
- 9am local time: sends at the next 9am in the workspace time zone. Bots only; for a channel, pick a time instead ("Local-time sending works for bots").
The workspace time zone is set by the owner in Settings → Workspace → Time zone. Set it to where most of your audience lives. Castvoo does not detect each subscriber's own time zone.
Scheduled messages can be cancelled from the message list before they go out. If the plan is paused when a scheduled message is due, it is not sent (it shows as failed) and you can send it again after topping up.` },

  { key: 'media-limits', title: 'Photos, videos and length limits', body: `- Text message: up to 4,096 characters ("Telegram allows 4,096 characters per message").
- With a photo or video, the caption can be up to 1,024 characters ("With a photo or video, Telegram allows 1,024 characters"). Shorten it or remove the photo.
- Photos up to 10 MB: JPG, PNG, GIF, WEBP. Videos up to 50 MB: MP4, MOV.
- "Use a JPG, PNG, WEBP, GIF, MP4 or MOV file" / "That file does not match its type": export the file again in one of those formats.
- "Your workspace has no room for more photos and videos right now": files not used in any message are cleared after 3 days. Reuse a file you uploaded, or try again later.
- {name} counts as 20 characters when checking length.` },

  { key: 'buttons-links', title: 'Buttons and click tracking', body: `Each message can have up to 6 buttons. Each button opens a web link. Castvoo turns the link into a short tracked link, so you see how many people clicked and, for bot messages, exactly who clicked. For channel and group posts you see click totals only. See clicks under Clicks and in each message's report.
Every bot broadcast also gets a "Stop these messages" button by default. People who tap it, or type /stop, stop receiving broadcasts. This keeps spam reports and bans away. You can switch it off per message, but we recommend keeping it.` },

  { key: 'audiences', title: 'Audiences', body: `An audience is a saved filter on your bot subscribers. Rules: came from start link, has tag, Telegram language, joined in the last N days, clicked in the last N days, no clicks in the last N days. Up to 6 rules.
Audiences only work for bots, because channels and groups don't let bots see their members ("Audiences only work for bots. A channel or group post goes to everyone in it").
Audiences → New audience. The count updates as you add rules. Then pick it in Send a message → Who gets it.
Tags: select people in Subscribers and add a tag (letters, numbers, _ and -).` },

  { key: 'drips', title: 'Auto follow-ups (drips)', body: `A follow-up is a list of messages with waiting times, like: welcome now, tip after 1 day, offer after 3 days. Up to 20 messages in one follow-up.
Each message has a wait before it: "Right away" (0), or 1 to 999 seconds, minutes, hours or days (all waits together: 365 days at most). Short waits are on time: "Wait 2 seconds" sends about 2 seconds after the message before.
Triggers:
- Someone presses Start on your bot
- Someone presses Start through a specific start link tag
- A subscriber gets a tag
People who ask to join a channel or group are welcomed by Welcome Flows (dashboard → Welcome Flows), not here. Join-request follow-ups made before Welcome Flows existed show up there.
Auto follow-ups are not on the Free plan ("Auto follow-ups are on the Starter plan and up").
Follow-ups are sent by a bot, so connect a bot first ("Follow-ups are sent by a bot. Connect a bot first").
If a person blocks the bot or taps Stop, their follow-ups stop. Switching a follow-up off pauses it for everyone; switching it on again continues.
Only the owner (and "Can send" members) can create, edit, switch on/off or delete follow-ups. Drafts-only members see "Ask the owner to ...".
Cas can write a whole sequence for you: in the follow-up editor tap "Write one with Cas" (one AI write per message).` },



  { key: 'start-links', title: 'Start links (which ad brought each person)', body: `A start link looks like t.me/yourbot?start=meta_ad14. Put a different one in each ad or post. When someone presses Start through it, Castvoo saves "meta_ad14" as where they came from. You see counts per link (Channels & bots → your bot → Start links) and can build audiences and follow-ups from them.
Tags can use letters, numbers, _ and -, up to 64 characters, no spaces ("Use only letters, numbers, _ and - (no spaces), up to 64 characters").` },

  { key: 'stop-blocked', title: 'Stop, unsubscribes and blocked users', body: `- "Stop these messages" button (on by default for bot broadcasts) and /stop: the person stops getting broadcasts and follow-ups. They show as "stopped". If they press Start again, they are active again.
- Blocked: when someone blocks your bot, Telegram refuses messages to them. Castvoo marks them "blocked", stops their follow-ups and stops sending to them. They do not count as active subscribers.
- In a broadcast report, "Blocked the bot" deliveries are those people. A few percent is normal; a lot means people get too many messages. Set Settings → Workspace → "Most messages one person gets per day" (2 or 3 is safe).` },

  { key: 'edit-pin-delete', title: 'Editing, pinning and deleting sent messages', body: `From the message list you can edit a sent message, pin it, or delete it. Edits change the message for everyone who received it.
Telegram only lets bots delete messages for 48 hours after sending, so Delete is greyed out after that ("Telegram only lets bots delete messages for 48 hours after sending").
"This message is still going out. You can edit it as soon as it has finished sending.": wait until sending is finished.
"Only sent messages can be pinned" / "Only sent messages can be deleted from Telegram": drafts and scheduled messages are cancelled instead.
Drafts-only and Can-send members may need the owner for edit, pin and delete ("Ask the owner to edit sent messages").` },

  { key: 'speed-delivery', title: 'Sending speed and delivery', body: `Castvoo sends about 25 messages per second per bot (Telegram allows about 30), so 10,000 people take about 7 minutes and 100,000 about an hour. A channel or group post is one message, so it goes out at once.
Several broadcasts from the same bot queue one after another. Follow-up messages go out in between.
If Telegram is busy it asks Castvoo to slow down; Castvoo waits and continues by itself. Nothing needs to be done.` },

  { key: 'no-read-receipts', title: 'What Castvoo cannot do (Telegram rules)', body: `- It cannot see who read a message. Telegram gives bots no read receipts, so no honest tool can show them. Castvoo shows what Telegram does share: delivered, clicked, replied and blocked. Channel views and reactions are visible inside Telegram only.
- It cannot message people who never started your bot (except the 5-minute join-request window that Welcome Flows use).
- It cannot see or export the members of a channel.
- It cannot add people to groups or channels without their consent.
- It cannot send faster than Telegram allows (about 30 per second per bot; Castvoo uses 25).
If a customer asks for any of these, explain kindly why and offer what does work.` },

  { key: 'approval-roles-sending', title: 'Approve before sending and drafts', body: `Settings → Workspace → "Approve before sending": teammates' messages wait for the owner to approve them ("pending approval"). The owner opens the message and taps Approve.
Drafts-only members can write but not send ("Your role can write drafts. Ask the owner to send"). Only the owner can approve ("Only the owner can approve messages").` },

  /* =========================== Troubleshooting playbooks =========================== */
  { key: 'tb-bot-not-sending', title: 'Playbook: bot not sending', body: `Check in this order:
1. Which plan is it on? The Free plan has no broadcasts or follow-ups ("Broadcasts are on the Starter plan and up"). A workspace moves to Free when the trial ends without a paid plan, when a cancelled plan's period ends, or when the wallet can't pay a renewal. Fix: Wallet → Top up and pick a plan; a plan that moved to Free because the wallet was short starts again by itself once a top-up covers it. Older workspaces can also show "Your plan is paused. Top up your wallet and pick a plan to start sending again".
2. Over the subscriber limit? "You have N bot subscribers and your plan allows M. Upgrade to keep sending. Nothing is deleted."
3. Does the bot show "Needs attention"? Paste a fresh token from @BotFather.
4. Is the webhook still pointing at Castvoo (another tool can take over a bot)? Support can repair it.
5. Did people press Start? Bots can only message people who started them. Share t.me/yourbot.
6. Look at the message report: "Blocked the bot" = those people blocked you; other errors are listed with counts.
7. Daily limit per person (Settings → Workspace) may skip people who already got messages today.` },

  { key: 'tb-broadcast-stuck', title: 'Playbook: broadcast stuck or slow', body: `- Status "Sending" with a big audience: it is normal. About 25 messages a second per bot; 100,000 people take about an hour. The report updates as it goes.
- Several broadcasts on one bot go one after another, so a new one waits for the one before.
- "Scheduled" that did not go: check the plan was active at that time. A paused plan makes scheduled sends fail, and a move to the Free plan turns scheduled messages back into drafts. Send it again after picking a plan.
- "Pending approval": the owner must approve it (Approve before sending is on).
- Castvoo maintenance pauses sending for a few minutes; nothing is lost.
- If it shows Sending for hours with nothing delivered, hand it to the technical team with the broadcast name.` },

  { key: 'tb-channel-not-connecting', title: 'Playbook: channel not connecting', body: `1. Link Telegram first (Settings → Link Telegram) with the same Telegram account that owns the channel.
2. Channels & bots → Add a channel → "Add @CastvooBot". Pick the channel and keep the admin rights ON (Post messages).
3. Wait a few seconds. @CastvooBot sends "connected" in Telegram.
4. Nothing happened after 30 minutes? The link expired: start again from step 2.
5. "already connected to another Castvoo workspace": remove it there first.
6. Private groups work too. For supergroups that changed id, Castvoo follows the new id by itself.
7. Still stuck: check @CastvooBot is an admin of the channel in Telegram (channel → Administrators).` },

  { key: 'tb-follow-ups', title: 'Playbook: follow-ups not sending', body: `1. Is the follow-up switched on (Auto follow-ups → toggle)?
2. Which plan is it on? Follow-ups are not on the Free plan. When a workspace moves to Free, its follow-ups (and every Welcome Flow except the first live one) are switched off and kept; after upgrading, the owner switches them on again.
3. Is the trigger right? "Start through a start link" only fires for that exact tag. "Gets a tag" only fires when the tag is added.
4. Did the person press Start? After a join request, only the welcome can be sent in the 5-minute window; later Welcome Flow steps need them to press Start ("Tap to start" button).
5. Blocked or stopped people get nothing more.
6. The bot shows "Needs attention"? Fix the connection first.
7. Waiting times count from the previous message, so a 3-day step comes 3 days after the one before it.` },

  { key: 'tb-login', title: "Playbook: didn't get the login code", body: `1. Check spam, promotions and updates folders. The email is from Castvoo with the subject "Your Castvoo login code: ...".
2. Wait a minute, then tap "Send a new code". Codes expire after 10 minutes, and only the newest code works.
3. Five wrong tries lock the code: tap "Send a new code" ("Too many wrong tries").
4. At most 5 codes per email per hour ("Too many codes for this email. Please wait an hour or use another way to log in").
5. Check the email is typed right. Other ways in: Log in with Telegram, or Continue with VooSquare.
6. Support can see whether the code email was sent (never the code itself). Castvoo staff never ask for your login code. Never share it.` },

  { key: 'tb-payment-not-credited', title: 'Playbook: payment made but wallet not credited', body: `1. Find the payment: Wallet shows pending payments with their reference (cv_...).
2. Card, bank transfer, USSD and mobile money through Flutterwave usually show within a minute (an older Paystack payment, from before Paystack was removed, can still be rechecked the same way). Coming back from the checkout page checks it again. Support can ask the provider again (recheck): the wallet is credited only if the provider confirms the payment, for the right amount.
3. Gatevoo crypto: USDT about a minute, Bitcoin about 10 minutes after the network confirms.
4. Manual methods (bank transfer, mobile money number, USDT sent by hand): did you press "I've paid" and add the reference or screenshot (or paste the transaction ID for USDT)? Then the finance team confirms it, usually within a few hours. Only they can approve it.
5. Sent a different amount than shown (the cents matter), or on the wrong crypto network? Tell support; finance checks it by hand.
6. Money left your bank but the provider says not paid: the provider usually reverses it within a few days. Support hands it to the payments team with the reference.` },

  { key: 'tb-limits', title: 'Playbook: limits and "upgrade" messages', body: `- Connections: "Your plan allows N connections. Upgrade to add more." Remove one or upgrade.
- Subscribers: above the limit sending pauses; nothing is deleted. Upgrade, or remove blocked/old bots.
- Seats: "You have N seats and all are in use" when inviting. Remove a member or cancel an invite, add extra seats in Settings → Team (paid plans), or upgrade.
- AI writes: "Cas has used all N AI writes for this period. They refill on <date>." There is never an extra charge. The Free plan has no AI writes.
- Join requests a month: see "Join requests per month". Over the limit, people are still let in but welcomes pause.
- Welcome Flows: "Your plan includes N Welcome Flows. Upgrade to make more, or edit the one you have." / "Your plan runs N live Welcome Flows. Switch another one off first, or upgrade."
- Steps per flow: "Your plan allows N messages per flow" (Free: "The Free plan sends 1 welcome message. Upgrade to Starter to add follow-up steps").
- Features: "... are on the <plan> plan and up (<price> a month). Upgrade to use it."
- Live bots: "Your plan runs N bots at the same time" when switching one on. Switch another bot off (drafts never count) or upgrade. Cas saves a new bot as a draft when the limit is reached.
- Bot types, messages per bot, menu buttons, lead questions and invite-friends bots: the builder explains kindly which plan has them.
- Lead answers a month: over the limit (+10%) the bot still says thanks; answers are kept hidden until next month or an upgrade, never deleted.
- Cas Builder builds: keep building in the builder (free), buy Cas credits in the wallet, or upgrade.
The exact limits and features of each plan (bots too) are in the live plan list.` },

  /* =========================== Cas =========================== */
  { key: 'cas', title: 'Cas, the AI helper', body: `Cas writes, rewrites ("shorter", "clearer", "more urgent", "friendlier", "fix spelling"), translates, writes follow-up sequences and answers questions about your workspace (Ask Cas). Cas can look at your connections, broadcasts, follow-ups and usage to explain why something did not send. It cannot change anything.
Train Cas: Ask Cas → Train Cas. Add your business, what you sell, audience, tone, offers, links, always/never rules, FAQs and example messages. Cas then writes in your style and only uses your real offers.
Cas never invents prices or results, never promises guaranteed profits, and writes [ADD DETAIL] when it needs a fact you have not given.
"Cas is very busy right now" or "Cas could not be reached": try again in a minute; the AI write is given back when it fails.` },

  { key: 'ai-writes', title: 'AI writes', body: `An AI write is one time Cas writes, rewrites or translates a message, or answers one question. A follow-up sequence counts one write per message in it. Each plan includes a monthly amount (see the live plan list). When writes run out, Cas waits until the next billing date (yearly plans refill every 30 days). There is never an extra charge. The Free plan has no AI writes, so Cas is on paid plans and the trial. Support chats with the AI support team do not use AI writes.` },
  { key: 'cas-builder', title: 'Cas Builder: build any bot by chatting with Cas', body: `Cas Builder builds a bot with you in a chat: a Welcome bot or a Chat bot. Open it from 🤖 Bots → "Build with Cas", from + New bot → Welcome bot → "💬 Cas Builder" (the recommended way; "🧩 Build it myself" opens the usual builder and templates), from + New bot → Chat bot → "Build it with Cas", from "Build your first flow with Cas" on Home, or with "💬 Open Cas Builder" on a saved bot to change it by chat.
Cas's first question is "What do you want your bot to do?", with answers to tap: 👋 Welcome people who ask to join my channel · ✅ Make people join my channel first · 🎁 Give a free gift · 📋 Show a menu · ❓ Ask people questions (collect leads) · 🔗 Get people to invite friends · ✍️ Something else (type it). Then Cas asks only what that bot needs, one tap at a time, with a "Recommended" answer and "✨ Just build it for me" on every question:
- ✅ Join-check: which Telegram bot (if you have several), which channel, what they get after joining (a gift link, a thank-you or your own words) and a reminder after 10 minutes (yes or no). Cas checks right away that your bot is an admin of the channel (it must be, to see who joined) and, if not, explains how to fix it: in Telegram open the channel → Administrators → Add admin → your bot, then tap "I've made it an admin".
- 🎁 Free gift: the link to your gift and when a friendly follow-up comes (right away, 1 hour, tomorrow, any time you type, or no follow-up). On Free it's just the gift (1 message per reply).
- 📋 Menu: the buttons (Prices, How it works, Talk to us are recommended; or type your own) and what each one sends (Cas writes it, you type it, or the button opens a link).
- ❓ Lead questions: which questions (Name, Phone number, Email, Country or your own; Cas picks the answer type, for example an email or phone check) and the thank-you at the end (or a gift link).
- 🔗 Invite friends: how many friends (3 recommended) and the reward (a link or a thank-you).
- ✍️ Something else: describe it in a few words. Common wishes are understood without AI; otherwise Cas writes the whole bot (this counts as your build) and it is checked like everything else.
If a kind of bot isn't in your plan, Cas says gently which plan has it and offers a similar one you can use now (for example a menu instead of questions on Free, or a free gift bot instead of invite friends on Starter). Lead questions are on Starter and up, invite friends on Growth and up; join-check, free gift and menu bots work on every plan. If you already run as many live bots as your plan allows, Cas saves the new one as a draft (switched off) and tells you to switch another one off or upgrade.
After building, the whole bot shows on the phone preview: tap any message or button to change its words, "See it play", send a test to your Telegram, then "Switch it on" (with the same checks as the builder). Cas gives you the bot's link (t.me/yourbot?start=CODE) to put in your ads and posts.
For a Welcome bot Cas asks one short question at a time and you tap an answer (or type your own): what your channel or group is about, which channel and bot (Cas helps you connect them if needed), how people get in, then Cas drafts your welcome from your business details (Train Cas). Tap "Looks good", "Make it shorter", "Friendlier", "Add an emoji" or "I'll type my own". Then: should people tap Start to get more, and "What should happen next?": send another message (right away, 5 seconds, 1 minute, 1 hour, tomorrow or any time you type), wait for them to tap Start, add a button (a link or a choice), remind them if they don't tap, or "I'm done". For choice buttons Cas asks what each one should send. The flow appears on the live phone preview as you go (on a phone, tap the preview bar at the top to open it).
You can type changes any time: "make message 2 shorter", "add a VIP button with link https://...", "wait 10 seconds before message 2", "delete the reminder", "rename the flow". Undo (↩ at the top) puts back the last change. The draft is saved as you go: close the chat and continue later from New flow.
At the end Cas offers a preview (the whole flow plays like a short movie), a test to your own Telegram (nothing is counted), and "Switch it on" with the same checks as the builder (your bot must be an admin of the channel with "Add members"; Cas explains how), or "Open in builder" to fine-tune.
Cas explains Telegram's rules when they matter: before people tap Start, the bot can message them only in the first 5 minutes, so later messages should come "when they tap Start"; a reminder for people who haven't tapped Start only works inside those 5 minutes.
Builds: a new bot made with Cas Builder (Welcome bot or Chat bot, one shared count) counts as one build; changing an existing bot by chat never counts, and taps on Cas's answers are free (most Chat bots are built from taps alone, with no AI). Cas Builder does not use AI writes. Each plan includes a number of builds (see the live plan list: the Free plan has its first flow). When they run out you can keep building in the builder (free), upgrade, or buy Cas credits from your wallet (see the live plan list for the pack; credits don't expire and use wallet cash, not bonus credit). Some days Cas Builder can be resting until tomorrow; the builder always works.
Video: the guide "Build your welcome bot with Cas" (about 80 seconds) shows a whole build: Offer VIP, the topic, the link, "✨ Just build it for me", See it play, a test on Telegram and Switch it on. Open it with "Build with Cas" at the top of Welcome Flows, "▶ Watch how" in the New flow chooser, or the Guides page.` },

  /* =========================== Money =========================== */
  { key: 'wallet', title: 'Wallet, payments and refunds', body: `Castvoo uses a prepaid wallet in US dollars. Plans renew from it. Bonus credit is used first, then cash.
Top up in Wallet → Top up. The methods depend on your country (Settings → Country): Flutterwave in Nigeria (card, bank transfer, USSD), Ghana (card, mobile money), South Africa (card), Kenya and Cameroon, card anywhere else, and crypto (USDT TRC20 or Bitcoin) everywhere. Paystack is no longer offered. The team can also add local methods, like a bank transfer or mobile money number. Minimum top-up is $10; very large top-ups must be split ("The largest single top-up is ... Split it into smaller top-ups").
Local-currency payments use the rate shown before you pay; the USD amount lands in the wallet.
"That payment method is not available for your country": change your country in Settings if it is wrong.
"Add your email in Settings first. The payment provider sends your receipt there.": card payments need an email on the account.
Refunds: unused top-ups (not bonus) within 14 days, back to the original method, minus processor or network fees. Email billing@castvoo.com. Plan periods that have started are not refunded, except double charges or billing errors, which are always refunded in full. Refunds are handled by the billing team only.` },

  { key: 'payment-methods-country', title: 'Payment methods by country', body: `- Nigeria: Flutterwave (card, bank transfer, USSD), paid in naira at the rate shown.
- Ghana: Flutterwave (card, mobile money) in cedis.
- South Africa: Flutterwave (card) in rand.
- Kenya: Flutterwave (card, M-Pesa) in shillings.
- Cameroon: Flutterwave (card, MTN and Orange mobile money) in CFA francs.
- Everywhere else: card through Flutterwave (in US dollars).
- Everyone: crypto. With Gatevoo on: USDT or Bitcoin on a secure Gatevoo page, confirmed automatically. Without Gatevoo: USDT (TRC20) sent by hand, confirmed by the team.
- The team's own methods (bank transfer, mobile money number, crypto wallet) for one country or everyone, confirmed by hand.
Paystack is no longer a payment method (removed in October 2026). Old Paystack payments are kept in the payment history and can still be checked.
What you see in Wallet → Top up is what is available for your country right now.` },

  { key: 'crypto', formerly: ['Crypto top-ups'], title: 'Crypto top-ups and Gatevoo', body: `When Gatevoo checkout is on, you pick USDT or Bitcoin on a secure Gatevoo page (Gatevoo is Zedapex's own crypto checkout) and your wallet is credited automatically once the payment confirms (USDT about a minute, Bitcoin about 10 minutes).
When Gatevoo is off, only USDT (TRC20) is offered. Castvoo shows our USDT address and an exact amount with unique cents (for example $50.37) so the team can match your payment. Send exactly that amount, paste the transaction ID, and the team confirms it, usually within a few hours.
Always send USDT on the TRON (TRC20) network only. Coins sent on the wrong network can be lost.
"A transaction ID uses only letters and numbers": copy it again from your wallet app. "That transaction ID was already used for another top-up": each transaction can be used once. If you sent a different amount, tell support in the Help chat.` },

  { key: 'manual-methods', title: 'Bank transfer, mobile money and other manual methods', body: `For methods the team checks by hand you see the payment instructions and an exact amount with unique cents. Steps:
1. Pay exactly that amount (keep the cents: they show the team it is yours).
2. Add the transaction reference from your bank or wallet app and/or a screenshot (JPG, PNG or WEBP, up to 10 MB), as the method asks.
3. Press "I've paid".
The team confirms it, usually within a few hours, and you get an email. The wallet is credited only after they confirm it. If it was rejected you get an email with the reason.
Messages: "Add the transaction reference or ID from your bank or wallet app", "Add a screenshot of the payment first", "That reference was already used for another top-up", "You already sent this payment to the team. They are checking it", "Too many people are paying this exact amount right now. Try a slightly different amount".
You can reopen the instructions from the pending payment in Wallet.` },

  { key: 'bonuses', title: 'Top-up bonuses', body: `When the offer is running: top up $200 → +$10, $500 → +$40, $1,000 → +$60 bonus credit (the active offers show in Wallet → Top up). Bonus credit pays for plans only and is not refundable or withdrawable. Bonuses are added automatically with the top-up; support cannot add bonuses or discounts by hand.` },

  { key: 'plans-renewal-cancel', title: 'Renewal, upgrades, downgrades and cancelling', body: `- Plans renew every month (or year) from the wallet. If the balance is too low, you get a reminder email 3 days before. If it is still short at renewal, the workspace moves to the Free plan (not paused, nothing is deleted): the first live Welcome Flow keeps welcoming, everything else is switched off and kept. The old plan starts again by itself once a top-up covers it.
- Upgrade any time in Wallet and plan: you pay the difference for the days left ("Your wallet needs ... to upgrade now. Top up and try again").
- Downgrades start at the next renewal.
- Yearly plans: pay 10 months, get 12.
- Upgrading from Free starts the new plan straight away (there is no period to pay the difference for).
- Cancel any time: Wallet and plan → switch off automatic renewal. The plan runs until the end of the paid period, then the workspace moves to the Free plan. Data is kept while the workspace is on Free and in use. If nobody uses a Free workspace for 12 months (no owner login, no join requests, no money in the wallet), we email the owner 30 days and 7 days before, then delete its content; logging in keeps everything, and the account and payment records always stay. Workspaces paused under the old rules keep their data for 60 days after the plan ended, then it is deleted.
- Coupons: Wallet and plan → Coupon code. "That code is not valid or has expired", "You already used this code", "This code has been used up".` },

  { key: 'referrals', title: 'Referral program', body: `Share your link (Earn page): castvoo.com/r/<your code>. When people sign up through it and pay for a plan, you earn a share of every plan payment they make, every month, for as long as they pay:
- 1 to 4 paying referrals: 5%
- 5 to 19: 10%
- 20 or more: 15%
The most anyone earns is 15% of a payment (monthly or yearly); there is no higher tier.
Earnings settle after 30 days (to cover refunds and chargebacks). Settled earnings can pay for your own plan any time, or be withdrawn in USDT (TRC20) or Bitcoin once they reach $300. Payouts are sent within 5 business days. One withdrawal at a time ("You already have a withdrawal being processed").
No self-referrals, fake accounts, spam, or paid ads bidding on the word "Castvoo". Breaking these rules cancels unpaid earnings. Referred people get the normal free trial.` },

  /* =========================== Account =========================== */
  { key: 'voosquare', title: 'VooSquare login and the Zedapex hub', body: `VooSquare (voosquare.com, "Media buying, squared.") is the Zedapex hub for all Voo tools for media buyers. One Voo ID logs you in to every Voo tool. "Continue with VooSquare" (Voo ID) logs you in to Castvoo with your VooSquare account; you can also link it later in Settings. Logging out of Castvoo also logs you out of VooSquare when you signed in with it.
Messages: "That VooSquare account is already linked to another Castvoo login", "Your Castvoo account is already linked to a different VooSquare account", "That email belongs to a different VooSquare account": log in with the matching account, or ask support.
Money stays inside each tool: you top up and pay for Castvoo in Castvoo's own wallet, not on VooSquare. Each Voo tool has its own plans and prices (see its own site). The full family is in "The Zedapex family of tools".` },

  { key: 'team', title: 'Team and roles', body: `Settings → Team → Invite (owner only). Roles inside a workspace: Owner (everything, including billing and connections), Can send (create and send messages and follow-ups), Drafts only (can write but an owner must send), Setup helper (sets up and runs the workspace with their own login; see the setup helper article). The number of seats depends on the plan (see the live plan list), plus any extra seats the owner bought (see "Extra team seats"). "You have N seats and all are in use" means remove someone, add a seat (paid plans) or upgrade. The setup helper never uses a seat.
The invite goes by email. "This invite was sent to ... Log in with that email, or add it to your account in Settings, then open the link again."
Ownership of a workspace cannot be moved by members; the support team handles ownership changes after checks.` },

  { key: 'team-seats', title: 'Extra team seats', body: `On any paid plan the workspace owner can add team seats on top of the plan's seats: Settings → Team → Add seats. The stepper shows the price as you change the number; the price per seat is in the live plan list (yearly plans pay 12 months).
- Adding seats: the new seats are paid now from the wallet for the days left of the current period (for example half a month left = half the price), then they renew together with the plan in the same wallet payment. The plan receipt email shows the seat line, and adding seats sends its own receipt. If the wallet is short, the dashboard offers a top-up ("Your wallet needs $X for N extra seats").
- Fewer seats: lower the number any time; nothing is refunded and the lower number starts at the next renewal. You can't go below the seats in use (members plus open invites): remove someone or cancel an invite first ("N people use seats now ... Remove someone or cancel an invite first").
- Seats you asked to remove can't be filled by new invites in the meantime.
- Not on the Free plan or during the free trial ("Extra team seats come with a paid plan" / "Extra seats can be added once your paid plan starts"). If a plan ends or drops to Free, its extra seats end too; nobody is removed from the team, but nobody new can be invited above the seats left.
- The setup helper is free on every plan and never uses a seat. Wallet → Your plan shows the seats and what renews.
- Sharing one login between several people is not a way to save seats: every login shows in Settings → Security, and a login from a new device or country sends the owner an alert. Teammates or a setup helper use their own login.` },

  { key: 'setup-helper', title: 'Setup helper: let someone set up your account without your password', body: `A setup helper is one person (for example your media buyer, a freelancer or a friend) who sets up and runs your workspace with THEIR OWN Castvoo login. Nobody shares a password. Every plan includes 1 setup helper, the Free plan too, and the helper does not use a team seat. One helper per workspace at a time.
Invite (owner only): Settings → Team → Setup helper → Invite a setup helper (also on the Home checklist, the Welcome Flows page and Help). Two ways:
- By email: only that email address can accept.
- Invite link: a one-time link to send on Telegram or WhatsApp. The first person who opens it, logs in (email code, Telegram or VooSquare) and taps Accept becomes the helper; then the link stops working. Making a new link cancels the old one.
Invites expire after 7 days. Before joining, the helper sees a screen with what they can and can't do, and taps Accept or Decline. The owner gets an email and a notice in the dashboard when the helper joins.
A setup helper CAN: connect bots, channels and groups; build Welcome Flows, follow-ups, audiences and start links; write, schedule and send broadcasts; see subscribers and add tags; Train Cas and use the AI writing tools; change workspace settings; top up the wallet with their own payment method if they want; chat with support about the workspace.
A setup helper CANNOT: see or change the owner's login, email, Telegram link, sessions or login codes; delete the workspace or the account; export all data (subscriber CSV); invite, remove or change teammates; cancel the plan; see, move or withdraw referral earnings or payout details; ask for refunds. They can change the plan and use coupons only if the owner turns on "Can manage billing & plan" (off by default).
Owner controls on the helper card: name, email or Telegram, joined date, last active, an Activity list of what the helper changed (for example "Created Welcome Flow 'VIP welcome'"), "Can send broadcasts" (on by default; off means the helper writes and schedules and the owner approves before anything goes out) and "Can manage billing & plan". Remove helper: they lose access straight away on every device and get an email. Messages and flows they scheduled keep running unless the owner cancels them.
The helper sees a "You're helping <workspace> as setup helper" bar with Leave, and a Helper badge in the workspace switcher. Things only the owner can do are hidden or say "Only the owner can do this".
Video: the guide "Invite a setup helper" (about 1.5 minutes, on the Guides page) shows all of this in the real dashboard. Open it with "Watch the guide" on the Setup helper card in Settings → Team or on the "Get help setting up" cards (Home and Welcome Flows).` },

  { key: 'settings-account', title: 'Profile, email and country', body: `Settings → Profile: name, email, country, marketing emails on/off. Changing your email sends a 6-digit code to the new address ("That email already belongs to another Castvoo account" means it is used by another login).
Country decides your payment methods and local currency.
Settings → Workspace (owner): name, time zone, most messages one person gets per day, approve before sending.` },

  { key: 'avatar-nickname', title: 'Your avatar and nickname', body: `Settings → Profile → Your avatar opens the avatar builder: a cartoon face for your account. Pick the face shape, skin tone, hairstyle (for example afro, braids, locs, buzz cut, fade, waves, bun, bob, curly, long, ponytail, hijab, headwrap, cap or bald), hair colour, eyebrows, eyes, mouth, facial hair, glasses, extras (earrings, headphones, chain), outfit (tee, hoodie, suit, jersey, kaftan, jacket, turtleneck), outfit colour and background. "Randomize" makes a random one and "Presets" has 24 ready-made avatars. Press Save avatar. You can also tap your avatar on Home, in the menu or in Settings to change it. New accounts are asked once ("Make your Castvoo avatar"); "Skip for now" is fine and you can make one later.
Your avatar shows on the dashboard (top bar, menu, Home), in your team's member list and next to your messages in the support chat. It is a drawing, not a photo.
Nickname (optional, up to 24 characters: letters, numbers, emoji, spaces and . _ - '): set it in Settings → Profile or in the avatar builder. Castvoo greets you with it ("Good morning, Dchessking 👋") instead of your name, and the support agents use it too. Clear the box to go back to your first name.` },

  { key: 'human-reply-times', title: 'When a person from the team replies', body: `The AI support agents answer in the Help chat at any hour, usually within seconds. When an agent hands a chat to a person on the team, the reply time depends on the plan:
- Free: within 24 hours.
- Paid plans: within one business day. The team works from 8am to 10pm West Africa Time (WAT), every day.
- Plans with priority support (Scale): within 4 business hours (8am to 10pm WAT).
Outside 8am to 10pm WAT, the business-hours promises count from 8am WAT, when the team is back. Email support@castvoo.com is answered by people in the same hours. Never promise a faster human reply than this.` },
  { key: 'data-privacy', title: 'Account, data and privacy', body: `Settings → Your data lets you download everything (export, as a file) or delete your account. Deleting removes your account, workspaces, bots and subscribers straight away and cannot be undone; only payment records that the law requires us to keep are retained. Type DELETE to confirm.
Customers are the controllers of their subscribers' data; Castvoo processes it for them. Castvoo never sells data and uses no advertising cookies.
Privacy requests can also be emailed to privacy@castvoo.com; we reply within 30 days. Data deletion and other privacy requests made in chat are handed to the privacy team.
Sub-processors: Railway (hosting), Telegram (delivery), Anthropic (AI writing and AI support answers; OpenRouter or OpenAI instead, only if the team switches to them), Flutterwave (payments; Paystack only for payments made before it was removed in October 2026), Gatevoo (crypto checkout), VooSquare (account hub if you sign in with it; the team's support inbox also gets a copy of support messages with your name and email), Resend (email). "Powered by Replyvoo" is only a label; Replyvoo gets no data.
Deleting the account also removes join requests, tracked links and clicks, and removes your teammates from the workspace.` },

  { key: 'security', title: 'Security', body: `Bot tokens are encrypted at rest (AES-256-GCM) and are never shown again, not even to support. HTTPS everywhere, login codes are hashed and lock after 5 wrong tries, staff access is by role and every admin change is in the audit log.
Castvoo staff and the AI support team will NEVER ask for your bot token, login code or password, and never ask you to send money to "unlock" anything. If someone does, it is not us: tell support.
If you think your bot token leaked: @BotFather → /revoke, then paste the new token in Channels & bots (subscribers stay).
Settings → Security → Active devices lists every phone and computer logged in to your account: device and browser (for example "iPhone · Safari"), the country (from the internet address, approximate), first seen and last active, with a "This device" badge. "Log out" ends one device at once (its next click asks it to log in); "Log out all other devices" ends all but this one. Castvoo keeps only the country and a scrambled (hashed) form of the address for this, never the address itself.
New-login alerts: when your account logs in from a device and country it has not used in the last 90 days, you get an email (and a Telegram message from @CastvooBot if you linked Telegram; that one can be switched off in Settings → Security). Not for the very first login of a new account. The alert has a "Log out all devices" button (works for 7 days): it logs out every device, then you log in again. If someone else has your login, use it, then secure your email and Telegram.` },

  { key: 'support', title: 'How support works', body: `Support is a live chat. Open it from the chat button at the bottom right of every page (on the website and in the dashboard) or from Help in the menu: both are the same conversation. AI support agents answer 24/7 in seconds and can see your account for you, read-only: your bots, channels and groups (names, status, admin rights, members, whether a bot still listens to Castvoo; never tokens), every Welcome bot and Chat bot (live or draft, start link, steps, leads, invites, errors), broadcasts and follow-ups (delivered, failed and why), your plan, limits and usage, wallet and payments (status only), team, setup helper, devices and login alerts, Cas Builder, referral earnings, withdrawals, coupons and top-up bonuses. They find common problems by themselves (a bot that isn't an admin, an invite link without join requests, a bot taken over by another program, a plan limit, people blocking the bot, a pending payment...) and explain the fix. They can recheck card and Gatevoo payments with the provider and re-check a bot's admin rights; after you say yes in the chat they can also re-point a bot's webhook, switch a bot on or off, or resend your verification email. They send tappable cards that open the exact page (your wallet, a bot, the plans, a video guide, a help article). They never move money: refunds and manual payments go to the team. For refunds, manual payment approval, legal, data deletion, ownership or when you ask for a person, a human teammate takes over in the same chat and you also get an email. To reach a person, just write it in the chat in your own words (for example "I'd like to talk to a person"): there is no special button. You can send up to 3 screenshots in one message (JPG, PNG or WEBP, up to 10 MB each): tap the image button (on iPhone it offers the camera or your photo library), paste, or drop them on the chat. The agents read them, for example a payment receipt or an error from Telegram or BotFather. Only you and the support team can open them, and photo details such as location are removed. A screenshot never counts as proof that money moved: only the payment provider or the finance team confirms a payment. When you are not logged in, the chat button on the castvoo.com website is the same support team (the same agents) and answers questions about Castvoo only (no account details) and takes text only: log in to send screenshots, check your account or have a teammate take over. Logged in, the chat button on the website opens your own support conversation. Support email: support@castvoo.com. Billing: billing@castvoo.com. Privacy: privacy@castvoo.com.` },

  { key: 'acceptable-use', title: 'Rules for what you can send', body: `Only message people who started your bot or joined your channel or group. No bought lists, scraping or adding people without consent. No scams, fake investment returns, guaranteed profits, malware, phishing, impersonation, hate, harassment, or content that sexualises minors. Trading, betting and financial offers must be legal for you and your audience and must not promise guaranteed profits. Follow Telegram's Terms of Service and Bot Platform rules.
Breaking these rules can get your Castvoo account suspended and your bot banned by Telegram. If Castvoo suspends an account for breaking the rules, unused wallet balance (not bonus) is refunded minus fees. "This account is suspended. Contact support@castvoo.com."` },

  { key: 'writing-tips', title: 'Writing Telegram messages that work', body: `- Lead with the benefit in the first line, because notifications show only the first line.
- One message, one goal, one button.
- Short paragraphs, one idea each. Emojis help scanning but use 1 to 3, not 10.
- Give a real reason to act now (a real deadline, limited seats). Never invent urgency.
- Welcome new people within a minute; that's when they are most interested.
- Send at the time your audience is awake. For West Africa, 7pm to 9pm often works; test it.
- Respect people: no spam, no fake claims, no promises of guaranteed profits.` },

  { key: 'maintenance', title: 'Maintenance and outages', body: `During maintenance, sending, sign-ups and top-ups pause for a few minutes and a banner explains it ("Castvoo is under maintenance. Please try again in a few minutes"). Nothing is lost: scheduled messages wait and follow-ups continue afterwards. If Telegram itself is down, messages retry by themselves.` },

  { key: 'tb-welcome-not-working', title: 'Playbook: Welcome bot not welcoming people', body: `Check in this order (support can check most of it for you):
1. Is the Welcome bot live? 🤖 Bots → the bot → switch it on. Only one Welcome bot can be live per channel (or per invite link).
2. Do people send join requests? The invite link they use must have "Approve new members" on (Telegram: the channel → Invite links → edit the link → Approve new members). A public @username link or a normal invite link lets people in without a request, so no welcome is sent. A live Welcome bot with no join requests for a day usually means this.
3. Is YOUR bot (not @CastvooBot) an admin of the channel with "Add members"? Telegram only sends join requests to admins who can let people in. Fix: the channel → Administrators → Add admin → @yourbot → turn on Add members.
4. Is the bot healthy? A revoked token or another program using the token stops it hearing join requests (see "Bot taken over by another program").
5. Over this month's join requests? People are still let in, but welcomes pause until next month or an upgrade.
6. Later messages only reach people who tapped Start (Telegram's 5-minute rule).` },

  { key: 'tb-join-check', title: 'Playbook: "You haven\'t joined yet" for people who joined', body: `A ✅ Check they joined step asks Telegram whether the person is in the channel. If everyone is told "Looks like you haven't joined yet":
1. The bot must be an admin of THAT channel (any admin rights), or Telegram won't say who is in it. Fix: the channel → Administrators → Add admin → @yourbot. Then support can re-check it for you.
2. Check the step points at the right channel (open the bot → the check step → channel).
3. The person must join with the same Telegram account they use with the bot, and finish joining (a pending join request is not "joined" yet).
4. A channel that is no longer connected: connect it again and pick it in the step.` },

  { key: 'tb-webhook-taken', title: 'Playbook: bot taken over by another program (webhook)', body: `A Telegram bot token can only send its updates to one place. If another tool, script or bot builder uses the same token (it sets its own webhook or reads updates), Castvoo stops hearing new subscribers, Start taps, button taps and join requests, even though sending may still work.
Signs: new subscribers stop, buttons do nothing, Welcome bots don't welcome.
Fix: stop using the token in the other tool (or make a separate bot in @BotFather for it), then let support re-point the bot to Castvoo (they ask you first), or paste the token again in Channels & bots. Subscribers, follow-ups and stats stay.
If the token was revoked in @BotFather, paste the new token in Channels & bots.` },

  { key: 'tb-start-link', title: 'Playbook: start link not working (Chat bots)', body: `1. Is the Chat bot live? Drafts don't answer.
2. The link must be exactly t.me/yourbot?start=CODE with the code of that bot (letters, numbers, _ and -). Copy it from the bot's page.
3. Two bots can't be live with the same code on one Telegram bot; only one Chat bot per Telegram bot can answer a plain Start ("Also answer a plain Start"). Switching on a bot with a clashing code offers to switch the other one off.
4. Codes starting with j_, cvf_, cvt, r_ or cv_ belong to Castvoo itself.
5. Someone who already started the bot gets it again from the top when they open the link again.
6. Is the bot healthy (token, not taken over by another program)?` },

  { key: 'tb-leads-invites', title: 'Playbook: leads and invites', body: `Leads (❓ Ask a question): open the bot → Leads, one row per person. Download CSV is for the workspace owner on Starter and up. Answers over the month's lead answers (+10%) are kept but hidden until next month or an upgrade (the bot still thanks the person). A reply that doesn't fit (wrong email, not a number) is asked again kindly. "Share my phone number" only accepts the person's own number.
Invites (🔗 Invite friends): only people NEW to that Telegram bot count, each once, never the inviter themselves, at most 50 counted per person a day. The Invites tab lists the invites that didn't count and why (already a subscriber, daily limit, a bot). The reward is the message set to "🏆 When they reach their invite goal".` },

  { key: 'tb-payment-pending', title: 'Playbook: payment pending or failed', body: `- Card, bank transfer, USSD or mobile money through Flutterwave: usually confirmed within a minute. Support can ask Flutterwave again (recheck); the wallet is credited only if Flutterwave confirms it.
- Crypto through Gatevoo: USDT about a minute, Bitcoin about 10 minutes after the network confirms. Support can recheck it with Gatevoo.
- Manual methods (bank transfer, mobile money number, USDT sent by hand): the finance team confirms by hand, usually within a few hours, after you press "I've paid" with the reference or screenshot. Support can't approve these; they pass it to finance.
- Failed or rejected: the reason is in Wallet. Try again with the exact amount (and the TRC20 network for USDT), or another method.
- "I paid" or a screenshot alone never credits a wallet: only the provider or the finance team confirms money.` },

  { key: 'zedapex-brands', title: 'The Zedapex family of tools (Voo brands)', body: `Castvoo is made by Zedapex (Zedapex Limited, Lagos, Nigeria), a company that builds SaaS tools for media buyers and runs performance marketing. Founder: Dchessking. These are ALL the Zedapex / Voo tools; nothing else is part of the family:
- VooSquare (voosquare.com): the hub and parent brand of all Voo tools for media buyers. Slogan: "Media buying, squared." One Voo ID logs you in to every Voo tool. Affiliate program at affiliate.voosquare.com. VooSquare Academy (voosquareacademy.com) is a free media buying school with free sign-up; the Premium community and the Inner Circle are paid.
- Joinvoo (joinvoo.com): a Telegram join tracker for paid traffic. It tracks which ads bring channel and group joins and bot subscribers, DM tracking, mini apps, a setup helper and alerts. Its tracking links use the domain gojoinly.com.
- Replyvoo (replyvoo.com): an AI agent that answers Telegram inboxes and support chats, plus a chat widget for websites. It powers Castvoo's support chat ("Powered by Replyvoo"). WhatsApp, Instagram and TikTok are coming soon.
- Vooads: an AI ad creative generator (videos, images and copy), paid with pay-as-you-go credits. Find it on VooSquare.
- Spyvoo: a live ad spy platform, "See what's winning", for every country. Find it on VooSquare.
- Glicto AI (glicto.com): an AI agent that creates and manages Meta, TikTok and Google ads.
- Gatevoo: Zedapex's own crypto checkout for USDT (TRC20) and Bitcoin, used inside the Voo apps (Castvoo's crypto top-ups). Its public site is a waitlist.
- Affleego (affleego.com): Zedapex's affiliate deals platform, run independently.
- Castvoo (castvoo.com): Telegram welcome bots, Chat bots, broadcasts and auto follow-ups.
Each tool has its own plans and prices on its own site (or on VooSquare); Castvoo support doesn't quote them. Money stays inside each tool.
Which tool fits: AI auto-replies to Telegram chats → Replyvoo. Knowing which ad brought the joins → Joinvoo. Ad videos and images → Vooads. Seeing winning ads → Spyvoo. An AI that runs the ads → Glicto AI. Learning media buying → VooSquare Academy (free). Affiliate offers → Affleego. Earning by promoting Voo tools → the VooSquare affiliate program (Castvoo also has its own referral program on the Earn page).
Not available anywhere yet: paid VIP memberships / selling access to a channel. It is not part of Castvoo; a separate Zedapex product is coming.
If someone names another product as "part of Voo" or "by Zedapex" (for example "Ebookvoo"), it is not one of ours.` },

  /* ======================================================================================================
   * PLANS, FREE PLAN, PRICING AND WELCOME FLOWS
   * Owned by the pricing work (Welcome Flows, the new Free plan and new pricing). Add or replace entries in
   * this block. Never write prices or per-plan limits as text: agents read them live from the plans table.
   * ====================================================================================================== */
  { key: 'plans-trial', title: 'Plans, trial and AI writes', body: `Plans: Free, then paid plans. Each plan includes everything in the plan before it. Plans differ in connections, bot subscribers, join requests a month, Welcome Flows, messages per flow, AI writes, team seats and features: always use the live plan list for names, prices, limits and features. Yearly = pay 10 months, get 12.
Free trial: the trial plan for the trial length shown in the live plan list, no card needed, with the trial's own AI writes and join requests (also in the live plan list). If no plan is paid when it ends, the workspace moves to the Free plan (it is not paused): the first live Welcome Flow keeps welcoming people; everything else is switched off and kept.
An AI write is one time Cas writes, rewrites or translates a message, or answers one question. A follow-up sequence counts one write per message. When writes run out, Cas waits until the next billing date. There is never an extra charge.
Subscribers = people who started your bots. Members of connected channels and groups do not count and are unlimited. Above the plan's limit, sending pauses until you upgrade. Nothing is deleted.
People who were paying on 8 October 2026 keep their AI writes and features while they stay on the same plan.
No setup fees. The only optional extra is extra team seats on paid plans (price in the live plan list).` },

  { key: 'free-plan', title: 'The Free plan', body: `The Free plan costs nothing and needs no card. It is for welcoming people who ask to join one channel or group:
- 1 channel or group, plus your own bot that sends the welcome (the bot does not count as a second connection on Free).
- 500 join requests a month, let in automatically.
- 1 welcome message: text or 1 photo, up to 3 link buttons, and {name} for their first name.
- Every Free welcome ends with "⚡ Free welcome bot by Castvoo.com". It links to your own referral link, so you can earn commission from it. It can't be removed on Free; any paid plan removes it. Because of that line, a Free welcome must be a little shorter than Telegram's normal limit.
- Not on Free: follow-up messages, broadcasts, the "Tap to start" button, stats, audiences, start links, Cas and extra seats (one setup helper is included, see the setup helper article). Support chats: a few instant AI support chats a month, then the team answers.
A workspace also moves to Free when the trial ends without a paid plan, when a plan is cancelled and its period ends, or when the wallet can't pay a renewal. Nothing is deleted. A top-up that covers the old plan starts it again by itself.` },

  { key: 'join-meter', title: 'Join requests per month', body: `Each plan includes a number of join requests a month (see the live plan list; the trial has its own amount). A join request is one person asking to join a channel or group that has a live Welcome Flow. The count resets on the 1st of each month (UTC); during the trial it counts the whole trial.
You get an email at 80% and at 100%, and the dashboard shows the meter, for example "312 / 500 free joins this month".
After the limit plus 10% extra, people are still let in automatically, so your channel keeps growing. But your welcome and follow-up messages pause until next month or until you upgrade. The dashboard shows how many people joined without your welcome. Flows set to "I decide" still wait for you.` },

  { key: 'bots', title: 'Bots: Welcome bots and Chat bots', body: `The 🤖 Bots page (it replaced "Welcome Flows" in the menu; nothing was lost, old Welcome Flows are the Welcome bots there) has two kinds of bot, built in the same builder:
- 👋 Welcome bot: starts when someone asks to join your channel or group (everything in "Welcome Flows" below).
- 💬 Chat bot: starts when someone opens your own bot and taps Start, through its start link t.me/yourbot?start=CODE (put it in ads and posts). Tick "Also answer a plain Start" so people who open the bot without a link get it too (one Chat bot per Telegram bot can do that). Everyone who starts it becomes a bot subscriber. One Telegram bot can run several Chat bots, each with its own code.
"+ New bot" asks what should start it, then offers ready templates you can change: ✅ Join my channel first, 🎁 Free gift from my ad (lead magnet), 📋 Menu with buttons, ❓ Ask a few questions, 🔗 Invite friends for a reward, 📣 Broadcast to bot subscribers, or ✨ Something else. The easiest way is "Build with Cas" (or "Build it with Cas" in the Chat bot list): Cas asks "What do you want your bot to do?" and builds any of these kinds by chatting (see Cas Builder).
Special steps (Add the next message → "Or add a special step"):
- ✅ Check they joined: the message, a link to your channel and an "I've joined ✅" button. When they tap it, the bot asks Telegram; joined → the next message, not joined → a gentle popup ("Looks like you haven't joined yet 🙂 ..."). Your bot must be an admin of that channel; Castvoo checks when you save and says how to fix it. Optional reminder if they don't tap. Works in Welcome bots too (after the welcome).
- ❓ Ask a question (Chat bots): the bot waits for their reply and checks it: text, number, email, phone (with a "📱 Share my phone number" button) or choice buttons. A reply that doesn't fit gets a kind "please try again". Answers are saved: open the bot → Leads, and the owner can download a CSV. Optional reminder if they don't answer.
- 🔗 Invite friends (Chat bots): each person gets their own invite link and sees their progress ({invite_link}, {invites}, {goal} in the text; "📊 My progress" button; /invite in the bot). The next message, set to "🏆 When they reach their invite goal", is the reward and is sent by itself. Only people new to your bot count, each once, never themselves, and at most 50 a day per person; the Invites tab shows the leaderboard and the invites that didn't count and why.
Broadcast: on a Chat bot, "📣 Broadcast to these people" opens Send a message with the audience "Started <bot name>" (people who stopped or blocked the bot are never messaged).
Preview: "Try it", "Preview this step", "Preview the whole bot" and "Send a test to my Telegram" all play the new steps: pretend they joined or not, type answers, and pretend a friend joined. A test counts and saves nothing.
Plans: Free runs 2 bots at a time (for example the welcome bot plus one Chat bot), with join-check, lead magnet and menu bots, 1 message per reply (a menu can answer up to 4 buttons); the first message of each Free bot ends with "⚡ Free bot by Castvoo.com". Starter adds broadcasts and lead questions (5 per bot, CSV export). Growth adds referral bots (2 live). Scale has no bot limit (fair use). See the live plan list for the numbers per plan. Over the month's lead answers (plus 10% extra) the bot still says thanks; the answers are kept and shown again next month or after an upgrade. Cas builds stay the only thing paid with credits.
Not available: paid memberships / selling access, and AI chat replies (separate products), and file attachments other than photos and videos (use a link button for a PDF).
Logged-in devices: each person can be logged in on 2 devices at once (3 on Scale). Logging in on one more logs out the oldest and sends the new-login alert.` },

  { key: 'welcome-flows', formerly: ['Join-request welcome'], title: 'Welcome Flows', body: `Welcome Flows (dashboard → 🤖 Bots → Welcome bots; "🤖 Bots" is the menu item that replaced "Welcome Flows", and old links still work) greet everyone who asks to join your channel or group, let them in, and follow up when they tap Start or a button.
Setup:
1. Connect your channel or group, and turn on "Approve new members" for its invite link so people send join requests.
2. Connect your own bot (from @BotFather).
3. Make that bot an admin of the channel with the "Add members" (invite users) right. Castvoo checks this and tells you how to fix it before a flow goes live ("@yourbot is not an admin of ... yet. In Telegram, open ... → Administrators → Add admin → @yourbot, and turn on Add members").
The fastest start: "Tell Cas what you want" at the top of a new flow. Describe your flow in one sentence (for example "Welcome them, ask them to tap Start, then send my VIP link") and Cas builds the messages, buttons and timing for you to check; it uses 1 AI write per message. Or pick a template in one tap: "Welcome + Tap Start + VIP link", "Welcome → Please tap Start reminder → Thanks + free gift", "Two choices: VIP or Free tips", "Welcome + 3-day follow-up", "Simple welcome only". Templates start as drafts.
A flow is a simple list of messages from top to bottom. The first one is the welcome, sent the moment someone asks to join. Between two messages a big chip asks "When should the next message come?" with 5 choices:
- ⚡ Right away: right after the message above.
- ⏱ After a wait: for example "Wait 2 seconds" or "Wait 1 day" (seconds, minutes, hours or days, 1 to 999 each, 365 days in all).
- 👆 When they tap Start: the moment they tap Start in your bot (the welcome's "Tap Start" button opens the bot). Castvoo adds the Tap Start button for you.
- 🔘 When they tap a button: pick which button of the message above. Each button can get its own answer: the answers show as tabs ("If they tap 'VIP signals' → ...", "If they tap 'Free tips' → ..."). If someone taps another button later, that answer comes too. Each answer is sent once, even after a double tap.
- 💤 If they don't respond in ...: a reminder if they have not tapped Start (or a button of the message above) in that time. It is cancelled as soon as they do.
Under each message one sentence says when it is sent ("Sends right after the welcome", "Sends the moment they tap Start", "Sends when they tap 'VIP signals'", "Sends if they haven't tapped Start after 10 minutes") and who it reaches.
Buttons: a Link button opens a web link (tracked, so you see who tapped); a Reply button has no link: tapping it sends the answer you picked, and it counts as a tap in your stats. Up to 6 buttons per message; Reply buttons sit two side by side. A message can also have {name}, a photo or a video.
"➡ Start another flow" on a message (Growth and up): once that message is sent, another flow of the same bot (a Welcome Flow or an auto follow-up) starts for that person from its first message. Each person goes through a flow once.
The phone next to the builder is a live preview you can tap: tap Start, Reply buttons and Link buttons like the person would, and skip waits and reminders with "⏩ Skip". On a phone, tap "▶ Try it".
On plans with Cas, each message also has "Write it with Cas" (1 AI write). Templates contain example text in brackets, like "(Write one useful tip for your audience here.)": the builder asks you to replace it before saving.
How do people get in (one question at the top): "After the welcome" (default: they get your message first; if Telegram refuses it, they wait in Requests), "Straight away" (even if the welcome fails), "When they tap Start" (they tap Start in the bot to get in; this stops most fake accounts), or "I decide" (approve or decline in the Requests tab, many at once).
On the flow page Castvoo shows how many people tapped Start: you can message them any time with "📣 Broadcast to these people", which opens Send a message with that bot and the audience "Tapped Start in <flow name>" (on every plan with broadcasts).
You can make several flows (how many, and how many messages each, depends on the plan), but only one can be live per channel (or per invite link): "... is already live on ... Save this one as a draft, or switch that one off first". A flow can have its own invite link (More options), so each ad can get its own welcome.
Plans: Free sends 1 welcome message. Starter and up: every "When should the next message come?" choice and Reply buttons. Growth and up: "Start another flow", A/B test the welcome (Scale: up to 4 versions), and "only if they clicked / didn't click" (in More options). Starter shows per-message deliveries and taps; Growth and up show the whole funnel.
Join-request follow-ups made before Welcome Flows existed keep working and show up here.
Videos: two guides show all of this in the real dashboard. "Build with Cas" (Build your welcome bot with Cas) and "Build it yourself" (the builder, step by step), both at the top of Welcome Flows, on the Guides page and as "▶ Watch how" in the New flow chooser.` },

  { key: 'five-minute-rule', title: 'The 5-minute rule and "Tap Start"', body: `Telegram's rule: after someone asks to join, your bot may message them for 5 minutes, until the request is handled. That is why Castvoo sends the welcome at once, before letting them in.
Messages in the first 5 minutes reach everyone who asked to join, even people who never tap Start: for example the welcome, then "Right away" or "Wait 10 seconds" and a second message, or a "💤 If they don't respond in 2 minutes" reminder. (The builder says "Reaches everyone · first 5 minutes"; waits after the welcome must add up to 4 minutes 40 seconds or less.) Letting someone in ends those 5 minutes, so with "After the welcome" or "Straight away" Castvoo lets them in right after the last of those quick messages (or as soon as they tap Start), automatically. With "When they tap Start" they get in when they tap; with "I decide" you let them in (if you do it before the quick messages go out, the rest wait for Start).
After the first 5 minutes, bots can only message people who pressed Start in the bot. So later messages only reach people who tapped Start ("Reaches people who tapped Start").
Add the "Tap Start" button to your welcome (Starter and up). It opens your bot; when they press Start, they become a bot subscriber, and every next message can reach them. Messages that come "👆 When they tap Start" always reach them. A Reply button tapped by someone who has not tapped Start, after the 5 minutes, waits: its answer goes out the moment they tap Start. People who never tap Start don't get later messages; Castvoo keeps them waiting for 7 days, then stops. A reminder they can't get is skipped (it asked them to tap Start anyway).
"When they tap Start" (the way in) uses the same button: they are let in when they press Start.` },
  /* ===================================== end of the pricing block ===================================== */
];

// Keys of defaults that were retired. syncKnowledge() removes their rows if the team never edited them.
//   join-welcome, welcome-flows-placeholder: replaced by the Welcome Flows article (welcome-flows).
module.exports.RETIRED = ['join-welcome', 'welcome-flows-placeholder'];
