# Castvoo front end (public/)

Plain JavaScript, no framework, no build step. `index.html` loads these classic scripts with `defer`, in this order. Every file shares the same global scope.

| File | What it holds |
|---|---|
| `core.js` | Helpers used everywhere: `$`, `$$`, `esc`, `fmt`, `money`, dates, `toast()`, `confetti()`, Cas the mascot (`cas()`), illustrated people for examples (`moji()`), initials avatars for real people (`ava()`), pop-ups (`sheet()`, `confirmBox()`, `closeModal()`), the setup guide player (`guide()`, `openGuide()`), the Gatevoo badge. |
| `api.js` | Talking to the server. `CFG` (site config from `/api/public/config`, with defaults), `ME` (who is logged in), `api()/GET()/POST()`, `apiErr()` (friendly error toasts, Wallet/Plan buttons for 402s), `upload()` for photos and videos, `WS` (which workspace). |
| `qr.js` | `qrSvg(text)`: real QR codes for crypto addresses. |
| `site.js` | The public website: texts, prices and FAQ from the config, example animations (always labelled "Example"), language switcher, help bubble. |
| `signup.js` | Sign-up and log-in (`#signup`, `#login`, `#signup/country`, `#signup/connect`, `#signup/plan`). |
| `app.js` | Dashboard shell: sidebar, top bar, bottom dock, page switching (`PAGES`, `appGo()`, `renderPage()`), shared bits (empty states, status pills, charts, page timers). |
| `app-home.js` | Home page. |
| `app-send.js` | Send a message (composer, history, report, edit), Ask Cas writing helpers, Calendar. |
| `app-drips.js` | Auto follow-ups. |
| `app-flows.js` | Welcome Flows: list, templates, the block builder with a Telegram preview, stats, the Requests list, and the upgrade prompts for plan features. |
| `app-people.js` | Subscribers, Audiences, Clicks. |
| `app-connect.js` | Channels & bots, connect wizard, Telegram linking, start links. |
| `app-cas.js` | Ask Cas chat and Train Cas. |
| `app-money.js` | Wallet and plan, top-up sheet (card, local methods, Gatevoo, manual crypto), Earn (referrals). |
| `app-account.js` | Settings and Help (support chat). |
| `app-zedapex.js` | Joinvoo / Replyvoo pages and the "More from Zedapex" cards. |
| `main.js` | Starts everything and routes by the address bar (`#…`). Loaded last. |

Styles are in `css/castvoo.css` (the legal pages use `css/legal.css`).

## Rules

- **No inline scripts or `onclick="…"` in HTML.** The Content-Security-Policy blocks them. Attach handlers in JS (`el.onclick = …`).
- **Never show made-up numbers.** Every number in the dashboard comes from the API. When there is no data, show an empty state with the next step. Marketing animations must carry an "Example" label.
- **Escape everything** that comes from users or the API with `esc()` before putting it into HTML.
- When you change a CSS or JS file, bump `?v=1` to `?v=2` in `index.html` (the server caches versioned files for a year).

## Add a dashboard page

1. In a page file (or a new `app-something.js` added to `index.html` before `main.js`):

   ```js
   PAGES.mypage = {
     title: 'My page', sub: 'One line about it',
     async render(el, q, alive) {
       el.innerHTML = skel(2, 120);               // loading placeholders
       const data = await GET('/api/something');
       if (!alive()) return;                      // the user left the page while we waited
       el.innerHTML = data.items.length ? '…' : emptyBox({ cas: 'wave', title: 'Nothing yet', text: 'What to do next.' });
     },
   };
   ```

   `q` is the query: `#app/mypage?x=1` gives `{ x: '1' }`. Use `every(ms, fn)` / `later(ms, fn)` for timers; they stop when the user leaves the page.

2. Add a sidebar button in `index.html` inside `#snav`:
   `<button type="button" class="si" data-v="mypage">…</button>`

3. Link to it from anywhere with `data-go="mypage"` (and `data-q="x=1"` for a query) or `appGo('mypage')`.

Errors: wrap calls in `try { … } catch (e) { apiErr(e); }`. `apiErr` shows the server's friendly message and adds a "Open wallet" / "See plans" button for money problems.
