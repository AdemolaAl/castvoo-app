'use strict';
/*
 * Cas's starting knowledge. The team edits and adds to it in Admin → Cas knowledge.
 * Cas reads the active articles before answering help questions and before
 * suggesting support replies. Keep each article short, true and specific.
 */
module.exports = [
  { title: 'What Castvoo is', body: `Castvoo sends Telegram messages for businesses and creators. It connects to a Telegram bot, channel or group and lets you:
- send a message now, later, or at the next 9am in the workspace time zone (the owner sets it in Settings to where their audience lives; Castvoo does not know each subscriber's own time zone)
- set up auto follow-ups that send themselves after someone starts the bot, uses a start link, asks to join a channel, or gets a tag
- send to an audience (part of your bot subscribers)
- add buttons with tracked links and see who clicked
- write, rewrite and translate messages with Cas, the AI helper
Castvoo is made by Zedapex in Lagos. It is not affiliated with Telegram.` },
  { title: 'Bots, channels and groups: the difference', body: `- Bot: people press Start on your bot. Castvoo can message each person one by one, so audiences, follow-ups and per-person click tracking work.
- Channel: a post goes to everyone in the channel. Bots cannot see channel members, so you cannot pick part of a channel. You see the member count, and clicks as totals.
- Group: like a channel, a message goes to the whole group chat.
Best setup for most businesses: a channel for public posts plus a bot that collects people for personal follow-ups.` },
  { title: 'How to connect a bot', body: `1. In Telegram, open @BotFather and send /newbot.
2. Pick a name and a username ending in "bot".
3. BotFather replies with a token like 123456789:AA... Copy it.
4. In Castvoo: Channels & bots → Add a bot → paste the token → Connect.
Castvoo checks the token with Telegram and starts listening. If it says the token is invalid, copy it again with no spaces, or send /token to BotFather to get a fresh one. One bot can only be connected to one Castvoo workspace at a time.` },
  { title: 'How to connect a channel or group', body: `In Castvoo: Channels & bots → Add a channel (or Add a group) → tap "Add @CastvooBot". Telegram opens, you pick your channel or group, and approve the admin rights. Castvoo connects it automatically within a few seconds.
Your Telegram account must be linked first (sign in with Telegram, or Settings → Link Telegram) so Castvoo knows the channel is yours.
For channels, @CastvooBot needs "Post messages" (and "Edit" and "Delete" if you want to edit or delete posts from Castvoo). For join-request welcomes, your own bot must be an admin with "Add members" (invite users) permission.` },
  { title: 'Sending a message', body: `Send a message → choose where it goes → choose who gets it (bots only) → write it → add a photo or video if you want → add buttons → choose Send now, Schedule or 9am local time → Send.
Limits from Telegram: a text message can be 4,096 characters. With a photo or video, the caption can be 1,024 characters. Photos up to 10 MB (JPG, PNG, GIF, WEBP), videos up to 50 MB (MP4, MOV).
Formatting: *bold* with stars, _italic_ with underscores.
Personal messages: write {name} (or tap "👤 Name") and each bot subscriber sees their own Telegram first name, for example "Hi {name}!" becomes "Hi Tunde!". If Castvoo has no name, or the message goes to a channel or group, {name} becomes "there". Choose your own word with {name|friend}. Works in broadcasts and auto follow-ups.
Speed: about 25 messages per second per bot, so 10,000 people take about 7 minutes.` },
  { title: 'Buttons and click tracking', body: `Each button can open a web link. Castvoo turns the link into a short tracked link, so you see how many people clicked and, for bot messages, exactly who clicked. For channel and group posts you see click totals only.
Every bot broadcast also gets a "Stop these messages" button by default. People who tap it, or type /stop, stop receiving broadcasts. This keeps spam reports and bans away. You can switch it off per message, but we recommend keeping it.` },
  { title: 'Audiences', body: `An audience is a saved filter on your bot subscribers, for example "came from start link meta_ad14", "language is French", "joined in the last 7 days", "clicked a link in the last 14 days" or "has tag vip". Audiences only work for bots, because channels and groups don't let bots see their members.` },
  { title: 'Auto follow-ups (drips)', body: `A follow-up is a list of messages with waiting times, like: welcome now, tip after 1 day, offer after 3 days.
Triggers:
- Someone presses Start on your bot
- Someone presses Start through a specific start link tag
- Someone asks to join your channel or group (join request)
- A subscriber gets a tag
If a person blocks the bot or taps Stop, their follow-ups stop. Switching a follow-up off pauses it for everyone.` },
  { title: 'Join-request welcome', body: `If your channel or group uses join requests (Telegram: invite link with "Request admin approval"), Telegram lets your bot message each person for 5 minutes after they ask to join. Castvoo sends the first step of your join-request follow-up straight away and can approve them automatically. The rest of the steps only reach people who then press Start on your bot, because Telegram closes the 5-minute window after that.
Setup: make your bot an admin of the channel with the "Add members" permission, then create a follow-up with the trigger "Someone asks to join".` },
  { title: 'Start links (which ad brought each person)', body: `A start link looks like t.me/yourbot?start=meta_ad14. Put a different one in each ad or post. When someone presses Start through it, Castvoo saves "meta_ad14" as where they came from. You can see counts per link and build audiences from them. Tags can use letters, numbers, _ and -, up to 64 characters.` },
  { title: 'Editing, pinning and deleting sent messages', body: `From the broadcast list you can edit a sent message, pin it, or delete it. Telegram only allows bots to delete messages that are less than 48 hours old, so Delete is greyed out after that. Edits change the message for everyone who received it.` },
  { title: 'What Castvoo cannot do (Telegram rules)', body: `- It cannot see who read a message. Telegram gives bots no read receipts.
- It cannot message people who never started your bot (except the 5-minute join-request window).
- It cannot see or export the members of a channel.
- It cannot add people to groups or channels without their consent.
- It cannot send faster than Telegram allows (about 30 per second per bot; Castvoo uses 25).
If a customer asks for any of these, explain kindly why and offer what does work.` },
  { title: 'Plans, trial and AI writes', body: `Every plan includes unlimited broadcasts, auto follow-ups, tracked clicks and Cas. Plans differ in connections, subscribers, AI writes and team seats (see the live prices in the plan list).
Free trial: 7 days of Growth, no card needed. During the trial Cas has 100 AI writes.
An AI write is one time Cas writes, rewrites or translates a message, or answers one question. A follow-up sequence counts one write per message. When writes run out, Cas waits until the next billing date. There is never an extra charge.
Subscribers = people who started your bots. Members of connected channels and groups do not count and are unlimited. Above the plan's limit, sending pauses until you upgrade. Nothing is deleted.` },
  { title: 'Wallet, payments and refunds', body: `Castvoo uses a prepaid wallet in US dollars. Plans renew from it.
Top up in Wallet → Top up. The methods depend on your country (Settings → Country): Paystack in Nigeria, Ghana and South Africa, Flutterwave in Kenya and Cameroon, card anywhere else, and crypto (USDT TRC20 or Bitcoin) everywhere. Local-currency payments use the rate shown before you pay. Minimum top-up is $10.
Top-up bonuses: $200 → +$10, $500 → +$40, $1,000 → +$100 (when the offer is running). Bonus credit pays for plans only and isn't refundable.
Refunds: unused top-ups within 14 days, back to the original method, minus processor or network fees. Email billing@castvoo.com. Plan periods that have started are not refunded, except double charges or billing errors.` },
  { title: 'Crypto top-ups', body: `When Gatevoo checkout is on, you pick USDT or Bitcoin on a secure Gatevoo page and your wallet is credited automatically once the payment confirms (USDT about a minute, Bitcoin about 10 minutes).
When Gatevoo is off, only USDT (TRC20) is offered. Castvoo shows our USDT address and an exact amount with unique cents (for example $50.37) so the team can match your payment. Send exactly that amount, paste the transaction ID, and the team confirms it, usually within a few hours. If you sent a different amount, tell support in the Help chat.
Always send USDT on the TRON (TRC20) network only. Coins sent on the wrong network can be lost.` },
  { title: 'Referral program', body: `Share your link (Earn page). When people sign up through it and pay for a plan, you earn a share of every plan payment they make, every month:
- 1 to 4 paying referrals: 10%
- 5 to 19: 20%
- 20 or more: 30%
Earnings settle after 30 days. Settled earnings can pay for your own plan any time, or be withdrawn in USDT (TRC20) or Bitcoin once they reach $300. Payouts are sent within 5 business days. Self-referrals and spam cancel earnings.` },
  { title: 'Troubleshooting', body: `- "Token invalid": copy the token again from @BotFather, with no spaces. Or send /revoke to BotFather and use the new token.
- Bot connected but nobody receives messages: people must press Start on the bot first. Share t.me/yourbot.
- Channel post failed: @CastvooBot lost admin rights or "Post messages" is off. Re-add it from Channels & bots.
- Some deliveries failed with "blocked": those people blocked your bot. Castvoo removes them automatically.
- Message failed "too long": shorten the caption to 1,024 characters or remove the photo.
- Didn't get the login email: check spam/promotions, wait a minute, then tap Resend. Codes expire after 10 minutes.
- Top-up paid but not showing: card and bank payments usually show within a minute; crypto needs confirmations. If it's been over an hour, send the payment reference in support chat.` },
  { title: 'Writing Telegram messages that work', body: `- Lead with the benefit in the first line, because notifications show only the first line.
- One message, one goal, one button.
- Short paragraphs, one idea each. Emojis help scanning but use 1 to 3, not 10.
- Give a real reason to act now (a real deadline, limited seats). Never invent urgency.
- Welcome new people within a minute; that's when they are most interested.
- Send at the time your audience is awake. For West Africa, 7pm to 9pm often works; test it.
- Respect people: no spam, no fake claims, no guaranteed profit promises.` },
  { title: 'Rules for what you can send', body: `Only message people who started your bot or joined your channel or group. No bought lists, scraping or adding people without consent. No scams, fake investment returns, guaranteed profits, malware, phishing, impersonation, hate, harassment, or content that sexualises minors. Trading, betting and financial offers must be legal for you and your audience. Breaking these rules can get your Castvoo account suspended and your bot banned by Telegram.` },
  { title: 'Team and roles', body: `Settings → Team → Invite. Roles inside a workspace: Owner (everything, including billing), Can send (create and send messages), Drafts only (can write but an owner must send). Seats per plan: Starter 1, Growth 3, Scale 10.` },
  { title: 'Account, data and privacy', body: `Settings → Your data lets you download everything (export) or delete your account. Deleting removes your account, workspaces, bots and subscribers straight away and cannot be undone; only payment records that the law requires us to keep are retained. Bot tokens are encrypted. Castvoo never sells data and uses no advertising cookies. Privacy questions: privacy@castvoo.com.` },
];
