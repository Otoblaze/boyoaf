# bọyọ

A platform where any organization can host its events: upload a flyer, get a registration page in the flyer's colors, issue QR tickets, and check people in at the door with a phone.

## Company account and front-desk logins

A company signs up once (the owner account). From the dashboard the owner adds a front-desk login for each person on the information desk (up to 50): a name, a login such as `desk1.gdguyo`, and a password. Everyone signs in at `/login` with their own details, and any number can be signed in at once.

| | Owner | Front desk |
|---|---|---|
| See the company's events, live numbers, attendees and guest list | yes | yes |
| Check people in or undo, add walk-ins, register an expected guest | yes | yes |
| Open the gate scanner (no gate key needed while signed in) | yes | yes |
| Create, edit or delete events, flyer, gate key | yes | no |
| Export attendees or the guest list, upload or clear the guest list, remove attendees | yes | no |
| Add, reset or remove logins | yes | no |

Removing a login signs that person out immediately. A desk login can only reach its own company's events. Volunteers who do not need an account can still use the scanner link and gate key.

## Event report

The owner's **Report** tab (not shown to front-desk logins) gives a report on how the event went: registered, checked in, turnout, who did not come, first and last arrival, arrivals through the day, how that compares with the start time, when people registered, expected guests who did or did not come, the top organizations, roles and interests, and how many joined the community. It can be opened at any time and reflects the check-ins recorded so far.

- **View and print** opens it as a page; use the browser's Print, then Save as PDF.
- **Download** saves it as an HTML file that opens in any browser.
- **Email it to me** sends a summary with the full report attached to the owner's account email. It never sends to any other address, and is limited to 5 sends per event per hour.

Times use the time zone of the browser that opens the report. Emailing needs a mail account: set `SMTP_URL` (for example `smtps://user:password@smtp.example.com:465`, from any SMTP provider) and optionally `MAIL_FROM` (for example `bọyọ <reports@yourdomain.com>`). Until `SMTP_URL` is set the button is switched off and says so; download still works.

## Google Calendar

**For attendees (works with no setup).** Every ticket page has *Add to Google Calendar* and an *Apple or Outlook (.ics)* button. The event's start and end time, place and a one-hour reminder go in. An event with no date shows neither. Without an end time, the calendar entry runs 2 hours.

**For attendees, one tap (needs the Google setup below).** The registration form shows "Add this event to my Google Calendar". If they leave it ticked, Google asks them to approve once and the event is placed in their own calendar with a reminder, and nothing is kept afterwards. This cannot happen without their approval; Google does not allow a website to write to someone's calendar silently.

**For organizers.** In *Details and branding*, the owner connects their Google Calendar and picks an upcoming event from a drop-down. Its date, end time, place, and (if empty) name and description are filled in. Nothing is saved until they press save. Only upcoming events are read, never changed. Front-desk logins do not see this.

### Set up Google (once, by whoever runs the server)

1. In Google Cloud Console, create a project and enable the **Google Calendar API**.
2. *OAuth consent screen*: choose External, add your app name (bọyọ), support email, and these scopes: `openid`, `email`, `.../auth/calendar.readonly` (organizers) and `.../auth/calendar.events` (attendees).
3. *Credentials*: create an **OAuth client ID** of type Web application. Add this authorised redirect URI exactly: `https://YOUR-SITE/api/google/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL` (your site address, `https://YOUR-SITE`) on the server.

Until Google has reviewed ("verified") the app, only people you list as test users can sign in, and they see an "unverified app" warning. That is enough for organizers (add them as test users). For the public to use one-tap add you need to submit the app for Google verification, which asks for a privacy policy page and a domain you own. Until then set `GOOGLE_ATTENDEE_ADD=false`: organizers keep the picker, and attendees keep the plain add-to-calendar button and .ics file, which never need approval. The organizer's Google refresh token is stored encrypted with a key derived from `TICKET_SECRET`; disconnecting revokes it.

## Upcoming events for attendees

After someone registers, their ticket page shows a "More events you can attend" list of other bọyọ events. An event appears there only if its organizer ticked "Show this event to people who have registered for other events on bọyọ" in Details and branding. New events default to listed; events created before this feature default to unlisted.

Only events that are open for registration, have a start date in the future, are not full, and that the attendee has not already registered for are shown (soonest first, up to 6). The list contains only public event-page information (name, tagline, organizer, date, venue, flyer colours, spots left), never attendee data. The ticket link is the credential for the list, and it is served with `no-store`.

The registration form remembers name, email, organization and role on the attendee's own device (localStorage) to make the next registration quicker. Consent boxes are never prefilled.

## Phone numbers

The registration form has an optional phone number field (and the front-desk "Add someone at the door" form too). A number is accepted if it has 7 to 15 digits and only digits, spaces, `+`, `(`, `)`, `-` and `.`; anything else is rejected with a plain message. Organizers and front-desk logins see it in the Attendees tab (and can search by it), and the owner's CSV export includes it. It is never shown in the public attendee directory or to other attendees. The form remembers it on the attendee's own device for next time.

## Brand

The site uses the bọyọ identity: cream, ink and door-orange, with Bricolage Grotesque (self-hosted in `public/fonts/`, SIL OFL) because it covers Yoruba letters such as ọ and ẹ. Logo files, icons and the share image are in `public/brand/`. Each event page, ticket and community page keeps the organizer's flyer colours and carries a small "Powered by bọyọ" footer. Event pages shared without a flyer fall back to `public/brand/og.png` as the preview image.

## How it works

1. An organization creates an account and an event, and uploads its flyer.
2. The event page, ticket and scanner pick up the flyer's colors. The organizer can adjust them.
3. Attendees register on the event page and get a signed QR ticket.
4. Volunteers open the scanner link on a phone and scan tickets. It keeps working when the venue network drops, then syncs.
5. Optionally, the organizer uploads a CSV of expected guests (Guest list tab). Each guest shows as not registered, registered or checked in, so it is clear who is missing. Matching is by email, or by exact name when the CSV has no email. A guest who has not registered can be registered and checked in from the list.
6. The organizer sees live turnout, the attendee list, a CSV export, and an opt-in attendee directory.

| Page | Who | Purpose |
|---|---|---|
| `/` | Public | Platform home |
| `/signup`, `/login` | Organizers and front-desk staff | Account |
| `/dashboard` | Organizers | Your events |
| `/dashboard/events/new` | Organizers | Create an event and upload the flyer |
| `/dashboard/events/:id` | Organizers | Overview, details and branding, attendees |
| `/e/:slug` | Attendees | Public event page and registration |
| `/t/:ticket` | Attendees | The QR ticket |
| `/e/:slug/community` | Attendees | Directory of people who opted in |
| `/scan/:slug` | Gate staff | Camera scanner (offline-capable) |

**Guest list CSV:** headings such as `Name`, `Email`, `Organization`, `Role`, `Phone` (also `First name` / `Last name`, `Company`, `Title`). Only a name is required. Comma, semicolon or tab separated; up to 1 MB and 5,000 rows. Without a heading row the columns are read as name, email, organization, role, phone. Excel files must be saved as CSV first. Uploading again adds only new people.

## Run locally

```bash
npm install
npm start                 # http://localhost:3000
npm run seed:demo         # optional: creates a demo organization and a Tech Ignite '26 event from samples/tech-ignite-flyer.jpg
npm test
```

The seed script prints the sign-in details, the event link and the gate key. Data is stored in `data.db` and `uploads/` in the project folder.

## Host it

The app is one Node process with a SQLite file, so the host needs **a persistent disk**. Serverless platforms (Vercel, Netlify) lose the database between requests and will not work. Phone cameras need HTTPS, which Render and Fly provide automatically.

In production the server refuses to start unless these are set:

| Variable | Meaning |
|---|---|
| `TICKET_SECRET` | Random string, 24+ characters. Signs tickets and organizer sessions. Changing it signs everyone out and invalidates issued tickets. |
| `SIGNUP_CODE` | Organizers must enter this code to create an account (6+ characters). Give it only to organizations you want on your platform. |
| `ALLOW_PUBLIC_SIGNUP=true` | Use instead of `SIGNUP_CODE` to let anyone sign up. |
| `SMTP_URL` | Optional. Turns on "Email it to me" for reports. A standard SMTP address such as `smtps://user:password@smtp.example.com:465`. |
| `MAIL_FROM` | Optional. The sender shown on report emails. Use an address your mail provider allows. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` | Optional. Turn on the Google Calendar features above. `PUBLIC_URL` is the site address, such as `https://events.example.com`. |
| `GOOGLE_ATTENDEE_ADD` | Set to `false` to switch off one-tap add for attendees while keeping the organizer picker. |
| `DATA_DIR` | Folder on the persistent disk (e.g. `/data`). The database and uploaded flyers are stored here. |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Render:** push this folder to GitHub, then New > Blueprint. `render.yaml` sets up the service, a 1 GB disk, a generated `TICKET_SECRET` and a generated `SIGNUP_CODE` (read it in the service's Environment tab).

**Fly.io:** see the commands at the top of `fly.toml`.

**Any VPS with Docker:**
```bash
docker build -t boyo .
docker run -d --restart unless-stopped -p 3000:3000 -v boyo-data:/data \
  -e TICKET_SECRET=<random> -e SIGNUP_CODE=<code> boyo
```
Put Caddy or nginx in front for HTTPS.

Back up the whole `DATA_DIR` folder (database plus `uploads/`).

## Event-day checklist

- In the event's Overview tab, copy the scanner link and the gate key. Open the link on each gate phone **while online** so the attendee list loads, then reload it once. It then keeps working offline and syncs when the network returns.
- Scan one real ticket before doors open.
- Someone not on the list can be added from the Attendees tab ("Add someone at the door") and checked in immediately.
- Changing the gate key signs out every scanner using the old one.

## Security notes

- Each event has its own gate key. A key opens only that event's scanner, and a ticket for another event is refused at the gate.
- One organization can never read, edit, export or delete another's events (covered by tests).
- Uploads are checked by file contents (JPG, PNG, WebP only, 6 MB max), never SVG, and served with a fixed content type.
- Registering again with an email that is already registered does not return that person's ticket. The organizer can open it from the Attendees tab.
- CSV exports neutralize spreadsheet formulas typed into attendee fields.

## Known limits

- No ticket email yet. Attendees get their ticket right after registering and should save the link or a screenshot. Organizers can open any ticket from the Attendees tab.
- No password reset or email verification for organizer accounts.
- Organizer sessions are signed cookies valid for 14 days. Signing out clears the cookie on that device but cannot revoke a copied one. Changing `TICKET_SECRET` signs everyone out.
- The guest list is visible only to the owning organizer. Guests are not added to the public directory or the scanner list until they register.
- Rate limits are in memory and assume a single server instance.
- Payments and paid tickets are not included.
