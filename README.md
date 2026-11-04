# Job Alert Bot

A free-to-run tool that watches job sites for you and keeps only the remote jobs you can actually apply for from your country.

Many "remote" jobs turn out to be open to one country only. This tool reads each posting, drops the ones that exclude you, scores the rest against your skills, and emails you a shortlist.

I built it because I live in Kenya and was losing hours opening jobs I could not apply for. It works for any country. You just tell it where you are.

## What it does

Every 30 minutes it:

1. Collects new jobs from your **LinkedIn** and **Indeed** job alert emails in Gmail, plus the public feeds of **Himalayas**, **Remotive**, **We Work Remotely**, **Remote OK** and **Jobicy**.
2. Skips any job it has already seen.
3. Throws away jobs that do not mention anything related to your skills.
4. Asks Claude (an AI model) to read each remaining job and decide:
   - Can someone in your country apply? (open to your region, worldwide, timezone-limited, unclear, or restricted)
   - How well do your skills match, from 0 to 10, and what skills are you missing?
5. Drops the restricted jobs, saves the rest to a Google Sheet, and emails you the best ones with a short summary and the exact sentence from the posting that supports the eligibility call.

You still choose what to apply for and do the applying yourself.

## What you need

- A Google account (Gmail and Google Sheets)
- A Claude API key from [console.anthropic.com](https://console.anthropic.com). API usage is billed separately from a claude.ai subscription. The cost is small at this volume, but check your usage in the console, especially in the first week.
- About 20 minutes

You do not need to know how to code. You will copy, paste and click.

## Setup

1. **Create a Google Sheet.** Name it anything, for example "Job Tracker".
2. **Open the script editor.** In the Sheet, click **Extensions**, then **Apps Script**. A code editor opens in a new tab.
3. **Paste the code.** Delete the placeholder code, paste the entire contents of `job_alert_bot.gs`, and click the save icon.
4. **Add your API key.** Click the gear icon (Project Settings) on the left. Scroll to **Script properties**, click **Add script property**, enter `ANTHROPIC_API_KEY` as the property and paste your key as the value. Save. Never paste your key into the code itself.
5. **Edit the settings at the top of the code** (see "Make it yours" below). At minimum, change `HOME_COUNTRY`, `HOME_REGION` and `PROFILE`.
6. **Run setup once.** In the toolbar, pick `setup` from the dropdown next to the Run button and click **Run**. Google will ask for permission. You will see a warning that says "Google hasn't verified this app." That is normal for a script you wrote or copied yourself. Click **Advanced**, then **Go to (your project) (unsafe)**, then **Allow**. When it finishes, the log says "Setup done" and two new tabs, Jobs and Seen, appear in your Sheet.
7. **Turn on job alerts.**
   - LinkedIn: search for your role, then switch on "Job alert" and set up an email alert.
   - Indeed: search for your role (try "remote" as the location), scroll to the bottom of the results, enter your email and click Activate. Indeed notes that alerts may not be available for searches set to some countries, so a remote search often works better.
8. **Test it.** Pick `run` from the dropdown and click **Run**. Check the execution log at the bottom, then your Jobs tab and your inbox.

After that, a timer runs it every 30 minutes by itself.

## Make it yours

All settings are in the `CONFIG` block at the top of the file.

| Setting | What it does |
|---|---|
| `HOME_COUNTRY`, `HOME_REGION` | Where you live. Claude uses these to decide if a job is open to you. |
| `PROFILE` | A short, honest description of your background. Claude scores fit against exactly what you write, so be accurate and mention gaps. |
| `ROLE_KEYWORDS` | A job is only sent to Claude if it contains one of these words. Keeps costs down. Set to `[]` to check everything. |
| `MIN_FIT` | Jobs scoring at least this (0 to 10) are emailed. |
| `LOG_MIN_FIT` | Eligible jobs scoring at least this are saved to the Jobs tab. |
| `INCLUDE_UNCLEAR_EMAIL` | LinkedIn and Indeed alert emails do not include the full job text, so eligibility cannot be confirmed. Leave `true` to see them marked "unclear", or set `false` to drop them. |
| `LOG_REJECTED` | Set `true` to keep dropped jobs in a "Rejected" tab, handy for checking the tool is not rejecting jobs wrongly. |
| `MAX_CLAUDE_CALLS_PER_RUN` | A cap on how many jobs Claude reads per run. Lower it to limit cost. |
| `EMAIL_TO` | Leave blank to email yourself. |
| `FEEDS` | Add any job site that publishes an RSS feed by adding a line with its name and URL. |

To change how often it runs, edit `everyMinutes(30)` in the `setup` function and run `setup` again. Allowed values are 1, 5, 10, 15 and 30.

## Good to know

- **Built to be checked.** For every job it keeps, the tool shows the exact sentence from the posting that supports its eligibility call, so you can verify it in seconds before you apply.
- **LinkedIn and Indeed work through your email alerts.** This keeps the tool within those sites' rules, because it never logs in to or scrapes them. Alert emails only include a title and company, so those jobs are marked "unclear". Open the posting to confirm. Jobs from the other sources include the full description, so their eligibility check is much more reliable.
- **Easy to repair.** If a source ever stops returning jobs, run the `debugEmailLinks` function. It prints what the alert emails contain so the matching pattern can be adjusted.
- **Runs on its own.** Once the timer is set, it checks every 30 minutes. The feeds show the latest jobs, so the longer it runs, the more complete your list gets.

## Privacy

- Your API key lives in Script properties, not in the code. Do not share it or paste it into the file.
- The script only reads Gmail messages that match the searches in `EMAIL_SOURCES`.
- The text of each job is sent to the Claude API to be analysed. Your own profile text is sent too, so do not put anything private in `PROFILE`.
- Everything else stays in your own Google account.

## Respect the job sites

This is for your own job search. Several sites ask for credit when their listings are used: the emails link every job back to its source, and you should keep it that way. Do not republish the listings elsewhere. Check each site's terms if you plan to use the data any other way. The tool reads your own email alerts and public feeds, and it does not log in to or scrape LinkedIn or Indeed.

## Troubleshooting

| Problem | What to try |
|---|---|
| "Add ANTHROPIC_API_KEY" error | Step 4 was skipped or the property name has a typo. |
| No emails arrive | Check the Jobs tab. If it has rows, lower `MIN_FIT`. If it is empty, check the execution log. |
| Jobs tab is empty and the log says `New candidates: 0` | Nothing new was found. Check your job alerts are switched on and wait for the next run. |
| LinkedIn or Indeed jobs missing | Run `debugEmailLinks` and check the sender address in `EMAIL_SOURCES`. |
| Lots of irrelevant jobs | Make `PROFILE` and `ROLE_KEYWORDS` more specific and raise `MIN_FIT`. |
| API errors in the log | Check your key, and that your Anthropic account has billing credit. |

## Credits

Built by Milena. I designed the tool, set it up, and tested it on my own job search, and I used Claude to help write the code.

Licence: MIT
