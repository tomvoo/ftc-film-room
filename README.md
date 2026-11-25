# FTC Film Room

Match video and scouting notes for Team 10137. The app takes an event's YouTube livestream and splits it into one clip per match. Students sign in, look up any team, watch its matches, and leave notes pinned to exact moments. They can also tag teams with features like "Strong auto" or "Plays defense".

It comes loaded with the **2026 Novi Qualifier (USMINOQ)**: all 57 matches, scores, team names and the Day 1 stream.

## Start it (5 minutes)

You need **Node.js 22.13 or newer** (https://nodejs.org, "LTS"). Nothing else gets installed.

```bash
cd ftc-film-room
node server.js
```

On the first run it prints an admin login (username `coach`) with a temporary password. Open http://localhost:3000 and sign in. It will ask you to pick a new password.

To set the admin password yourself on the first run, use `ADMIN_PASSWORD=something-long node server.js` (on Windows PowerShell: `$env:ADMIN_PASSWORD="something-long"; node server.js`).

## First thing: sync the video once (about 30 seconds)

The livestream doesn't say what time of day it started, so the app needs one reference point. After that it places every match automatically, using the start times FTC records for each match (to the millisecond).

1. Open **Q5** (or any match).
2. Use YouTube's scrubber to find the moment the match starts: the buzzer or "GO". The sync box tells you roughly what time of day to look for.
3. Pause on it and tap **Match starts here**.

Every other match now opens at the right spot. If the stream dropped and restarted partway through the day, the later clips will be a little off. Fix that by syncing one match after the gap, and everything after it shifts. **Start −1s / +1s** fine-tunes a single match.

Notes remember both the match time and the video time, so a later correction never moves a note off the moment it describes.

## Add students

Go to **Admin → People → Add a person**. Each account gets a one-time password; tap Copy and send it to the student. They pick their own password when they first sign in.

| Role | Can do |
|---|---|
| Scout | Watch, write notes, tag teams, edit or delete their own notes and tags |
| Lead | All of that, plus sync video and edit the feature list |
| Admin | Everything: people, events, backups |

## What students see

- **Matches**: every match with alliances, scores and clip status. Filter by any team; **Our matches** shows just 10137, with win/loss.
- **Teams**: a sortable table (record, average alliance score, note count, tags). Filter it by tag, for example "every team tagged Scores nectar".
- **Match page**: the clip with a match clock, an Auto / TeleOp / End timeline, and yellow pins for each note. Start typing and the note pins itself to that moment. Choose which robot it's about and a category, then save. Previous and next buttons step through one team's matches.
  Keys: `N` new note, `Ctrl+Enter` save, `K` play/pause, `J` / `L` back or forward 5 s.
- **Team page**: all of a team's matches, every note about them across matches (tap a time to jump to it), and their feature tags with who tagged them and why.

## Other events

Go to **Admin → Events → Add an event from FTCScout**. Enter the season (2026) and the event code from ftc-events.firstinspires.org (Michigan qualifiers look like `USMI…Q`). The app pulls the matches, scores, exact start times, team names and the FIRST in Michigan stream links from `fimav.us`. Then sync once, as above.

During a live event, tap **Mark live**. New matches and scores are then pulled in every 3 minutes. YouTube lets you scrub back through a stream that's still live, so clips work during the event.

If a stream link isn't picked up automatically, paste it under the event's **Stream videos** and give it the date it covers. Only YouTube is supported; a few FiM events stream on Twitch.

## Backups

- **Automatic**: every 6 hours (if anything changed), on shutdown, and before any delete or restore. Each one is a complete copy of the database in `data/backups/`. The latest 40 are kept.
- **Off-site**: set `BACKUP_DIR` to a folder that Google Drive, OneDrive or Dropbox syncs, for example `BACKUP_DIR="C:/Users/you/OneDrive/FilmRoomBackups" node server.js`. Every backup then also leaves the building.
- **Manual**: Admin → Backups → **Back up now**, or **Download everything (JSON)**.
- **Restore**: Admin → Backups → Restore from a JSON export. You can also stop the server, copy any `.db` backup over `data/filmroom.db`, and start it again.

## Hosting it on Google Cloud (uses your Google AI Pro credit)

This runs on a Compute Engine e2-micro, which is in Google's free tier, so it should cost about $0 a month. Your $10 monthly credit covers any small overage.

**One-time setup in the browser (about 10 minutes):**
1. Go to https://developers.google.com/profile → **My Benefits**. Apply the Google Cloud credit to a billing account. If you don't have one, it walks you through creating one; Google asks for a card even though the credit pays. Tick **Always use this billing account** so each month's credit lands there automatically.
2. Go to https://console.cloud.google.com → project picker → **New project** (for example `film-room-10137`). Make sure it's linked to that billing account.
3. Optional but smart: **Billing → Budgets & alerts**. Set a $10 budget with email alerts.

**Deploy (about 5 minutes):**
1. In the console, click the **Cloud Shell** icon (`>_`, top right).
2. In Cloud Shell's ⋮ menu, choose **Upload** and pick `ftc-film-room.zip`.
3. Paste:
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   unzip -o ftc-film-room.zip && cd ftc-film-room && bash deploy/gcp-deploy.sh
   ```
4. At the end it prints your web address (like `https://34-123-45-67.sslip.io`, with HTTPS already set up) and a one-time `coach` password.

It creates one small server in Iowa (us-central1), a fixed IP so the address never changes, a firewall rule for web traffic only, and a Cloud Storage bucket. The server copies every backup to that bucket, so they survive even if the server is lost.

**Updating later: automatic from GitHub.** The script also sets up a "film-room-deployer" account that only GitHub Actions on this repo's `main` branch can use, and that can only update this one server. It ends by printing a line like `GCP_PROJECT=… GCP_PROJECT_NUMBER=… SITE_HOST=…`. Put those values in `deploy/gcp.env` (or send the line to Claude), and from then on every push to `main` does this:
1. Runs the tests (`.github/workflows/deploy.yml`).
2. If they pass, sends the new code to the server (`deploy/gcp-update.sh`).
3. The server's updater installs it within seconds. Notes, accounts and backups are untouched.
4. The workflow waits until the site reports the new version.

No password or key is stored in GitHub; the sign-in uses Google's Workload Identity Federation. You can also run `bash deploy/gcp-deploy.sh` again from Cloud Shell at any time to push the code in that folder.

**Your own domain:** run with `SITE_HOST=film.yourteam.org bash deploy/gcp-deploy.sh` after pointing that name's DNS A record at the IP.

## Other ways to host it

- **A school or team computer that stays on.** Run `node server.js`. Students on the same network open `http://<that-computer's-IP>:3000`. To reach it from home, a free Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) gives you an https link without opening ports.
- **A small cloud host** (Railway, Fly.io, Render with a persistent disk, a $5 VPS). Use the included `Dockerfile` and mount a volume at `/data`. Set `SECURE_COOKIE=1` when it's served over https, and `TRUST_PROXY=1` behind the host's proxy.
- **Raspberry Pi**: same as the school computer.

Settings (environment variables): `PORT` (3000), `DATA_DIR` (./data), `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS` (6), `BACKUP_KEEP` (40), `ADMIN_USER`, `ADMIN_PASSWORD`, `OUR_TEAM` (10137), `SECURE_COOKIE`, `TRUST_PROXY`.

## Security notes

Passwords are hashed with scrypt. Sessions are HttpOnly cookies that last 30 days. Logins are rate-limited, and the server refuses requests from other sites. Disabling an account signs that person out right away. Video comes straight from YouTube; the app stores no video, only notes and match data.

## Checking it works

With the server running: `node test/smoke.mjs http://localhost:3000 coach <password>`. It runs about 30 checks: logins, roles, clip placement, notes, tags, backup and restore. It adds a test account (`student1`) and some notes, so run it on a scratch copy (`DATA_DIR=/tmp/fr-test`), not your real data.

Data sources: match schedule, start times and scores from FTCScout (api.ftcscout.org); team list from ftc-events.firstinspires.org; stream from FIRST in Michigan's YouTube channel.
