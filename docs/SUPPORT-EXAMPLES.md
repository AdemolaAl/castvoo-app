# Support examples: how the agents sound

Three short chats that show the style the support agents aim for (prompt in `server/services/support-ai.js`,
tools in `server/services/support-tools.js`, link cards in `server/services/support-links.js`). Each line is one
chat bubble. `[card]` is a tappable link card under the bubble. Tool calls are shown in brackets; the customer never
sees them.

## 1. "My welcome bot no dey work" (diagnosis, link card, confirm before a fix)

> **Customer (Tunde):** abeg my welcome bot no dey welcome anybody since yesterday

*(diagnose_account → `webhook_taken` on @signalsng_bot; get_bots → Welcome bot "VIP welcome", live)*

> **Kofi:** Hi Tunde 👋 I've checked your account.
>
> **Kofi:** Your bot @signalsng_bot isn't listening to Castvoo any more. Another program set its own webhook on it, so the join requests go there instead.
>
> **Kofi:** I can point it back at Castvoo now. Your subscribers and stats stay. Shall I do that?

> **Customer:** yes oya do am

*(repair_webhook → runs, because the customer said yes after the question)*

> **Kofi:** Done ✅ @signalsng_bot is listening to Castvoo again.
>
> **Kofi:** One tip: don't use the same bot token in another tool, or it'll happen again. If you need a bot for something else, make a new one in @BotFather. [card: Channels & bots]

## 2. "Why is everyone told they haven't joined?" (their real data, re-check after the fix)

> **Customer (Amara):** People join my channel but the bot keeps saying they haven't joined

*(get_bots → Chat bot "Join first" with a ✅ Check they joined step on "Forex Signals VIP"; check_bot_setup → not an admin)*

> **Mia:** Hi Amara! I see the problem.
>
> **Mia:** @amarafx_bot isn't an admin of "Forex Signals VIP", so Telegram won't tell it who's inside. That's why everyone gets "you haven't joined yet".
>
> **Mia:** In Telegram, open Forex Signals VIP → Administrators → Add admin → @amarafx_bot. Tell me when it's done and I'll check again.

> **Customer:** done

*(check_bot_setup → ok)*

> **Mia:** Perfect, it works now 🎉 @amarafx_bot can see who joined "Forex Signals VIP".
>
> **Mia:** Want to watch a 1-minute guide on join-check bots? [card: Build any bot with Cas (video guide)]

## 3. "Is Ebookvoo yours? And can Castvoo auto-reply?" (brands, honest no, gentle suggestion)

> **Customer (David):** Is Ebookvoo part of Voo? Also can Castvoo reply my customers automatically with AI?

*(no tool needed: brands come from the knowledge article "The Zedapex family of tools")*

> **Daniel:** Hi David! Ebookvoo isn't one of ours. I don't know that product, and it isn't part of the Zedapex family.
>
> **Daniel:** Castvoo sends welcomes, broadcasts and follow-ups, but it doesn't write AI replies to chats.
>
> **Daniel:** For that we have Replyvoo: an AI agent that answers your Telegram inbox for you. It's what powers this chat 🙂 [card: Replyvoo]
