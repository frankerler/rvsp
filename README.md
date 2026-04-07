# RSVP Event Platform

A simple, free, self-hosted RSVP tool for small events like meetups, workshops, or community gatherings. Create an event page, share the link, and let people sign up. No accounts needed for guests -- just name and email.

When spots fill up, a waitlist kicks in automatically. If someone cancels, the next person on the list gets promoted and notified by email. You manage everything from a password-protected admin panel -- edit event details, track signups, and export your guest list as CSV.

Built with Node.js, Express, and SQLite. No external database, no third-party services required (except for email). Deploy it on Railway or any Node.js host and you're good to go.

## Features

- **Event pages** -- shareable dark-mode event pages with date, time, location, and RSVP form
- **Automatic waitlist** -- when an event is full, new signups are waitlisted. When a spot opens, the next person is auto-promoted and notified by email
- **Styled email notifications** -- confirmation, waitlist, and promotion emails with dark-mode templates matching the event page
- **Admin panel** -- create and manage events, edit site settings, view guest lists, download CSV exports
- **Markdown-like formatting** -- use bold, lists, and links in event descriptions
- **Configurable admin URL and password** -- hide your admin panel behind a custom path
- **No external database** -- SQLite with persistent volume support for cloud deployment

## Quick Start

```bash
git clone https://github.com/frankerler/rsvp.git
cd rvsp
npm install
npm start
```

Open `http://localhost:3000` in your browser. The admin panel is at `/admin.html` (default password: `admin`).

## Environment Variables

Create a `.env` file in the project root:

```env
# Server
PORT=3000
BASE_URL=http://localhost:3000

# Admin panel
ADMIN_PATH=/admin.html        # Custom URL path for the admin panel
ADMIN_PASSWORD=admin           # CHANGE THIS — use a strong, unique password

# Email (choose one of the three options below)
EMAIL_FROM_NAME=My Event       # Display name in the From field
```

### Email Setup

The platform supports three email providers. Choose one:

#### Option 1: Gmail SMTP (local development)

Works on localhost but blocked by most cloud providers (Railway, Render, etc.) because they block outbound SMTP ports.

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
```

To get a Gmail app password: Google Account > Security > 2-Step Verification > App passwords.

#### Option 2: Gmail API (recommended for cloud deployment)

Uses HTTPS instead of SMTP, so it works everywhere including Railway. Emails come from your real Gmail address.

```env
GMAIL_USER=you@gmail.com
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-...
GMAIL_REFRESH_TOKEN=1//...
```

Setup steps:

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project and enable the **Gmail API**
3. Go to **Google Auth Platform > Clients** and create an OAuth 2.0 Client ID (Web application)
4. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI
5. Go to **Audience** and add your Gmail address as a test user (or publish the app)
6. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
7. Click the gear icon, check "Use your own OAuth credentials", and enter your Client ID and Secret
8. Select the scope `https://www.googleapis.com/auth/gmail.send`, then authorize and exchange for tokens
9. Copy the **Refresh Token** and set the environment variables above

#### Option 3: Resend (HTTP-based, requires custom domain)

```env
RESEND_API_KEY=re_...
EMAIL_FROM=Your Name <hello@yourdomain.com>
```

Sign up at [resend.com](https://resend.com), add and verify your domain, then set the API key. Free tier supports 3,000 emails/month. Without a verified domain, emails may land in spam.

#### No email configured

If none of the above are set, the app runs normally but skips sending emails. RSVPs still work -- guests just won't receive confirmation emails.

## Deployment

This app can be deployed to any Node.js hosting platform. [Railway](https://railway.app) is a good option -- it's easy to set up, has a free trial, and supports persistent volumes for SQLite.

### Railway

1. Push to GitHub
2. Create a new project on [Railway](https://railway.app) and connect your repo
3. Add a **Volume** mounted at `/data` (for SQLite persistence)
4. Set environment variables in the Railway dashboard (see above)
5. Deploy

The app automatically detects `RAILWAY_VOLUME_MOUNT_PATH` and stores the database on the persistent volume.

Other platforms like [Render](https://render.com), [Fly.io](https://fly.io), or a simple VPS will work too -- just make sure you have a way to persist the SQLite database file.

## Admin Panel

Access the admin panel at your configured `ADMIN_PATH` (default: `/admin.html`). From there you can:

- Edit site settings (title, headline, subtitle)
- Create and manage events
- Edit event details and descriptions
- View confirmed guests and waitlist
- Download guest lists as CSV

### Description Formatting

Event descriptions support basic formatting:

- `**bold text**` for bold
- `- item` or `* item` for bullet lists
- `[link text](https://url)` for links
- Empty lines create paragraph breaks

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** SQLite via better-sqlite3
- **Email:** Nodemailer (SMTP), Gmail API, or Resend
- **Frontend:** Vanilla HTML/CSS/JS

## License

MIT
