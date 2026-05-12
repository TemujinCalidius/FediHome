# Install FediHome with AI (no coding required)

You don't need to know how to code to run your own corner of the Fediverse. This guide assumes **zero technical background** — you just need to be able to copy and paste.

The trick is to let an AI assistant — **Claude Code** — drive the installation for you. It will run commands, install software, set up your database, troubleshoot errors, and explain anything you ask. You stay in the driver's seat; the AI does the typing.

---

## Step 1 — Get Claude Code

Claude Code is a free-to-try AI assistant that runs in your terminal (or in the Claude desktop app). It can read your computer, install software, and run commands, but always asks before doing anything risky.

- **Desktop app (easiest):** Download from [claude.com/claude-code](https://claude.com/claude-code) — works on Mac and Windows
- **Terminal version:** Install with `npm install -g @anthropic-ai/claude-code` if you already have Node.js

You'll need an Anthropic account. Free tier is plenty for installing FediHome.

---

## Step 2 — Open Claude Code in an empty folder

Make a folder where you'd like FediHome to live, then open Claude Code inside it. On Mac:

1. Open **Terminal** (press `Cmd+Space`, type "Terminal", hit Enter)
2. Type these three commands, one at a time, pressing Enter after each:
   ```
   mkdir ~/fedihome-install
   cd ~/fedihome-install
   claude
   ```

That last line opens Claude Code in that folder.

If you got the desktop app instead, just launch it and tell it to open the `fedihome-install` folder.

---

## Step 3 — Paste this prompt

Once Claude Code is open, copy this entire block and paste it as your first message:

```
I want to install FediHome on this computer. FediHome is a self-hosted
publishing platform that connects to the Fediverse. The repository is at:
https://github.com/TemujinCalidius/fedihome

Please install it for me. I am not a technical user — I don't know how to
code. Walk me through this step by step:

1. Run the one-line installer from FediHome's README. The command is:
   curl -sSL https://raw.githubusercontent.com/TemujinCalidius/fedihome/main/install.sh | bash

2. The installer will ask me questions (like whether to install PostgreSQL,
   whether to create a database, etc.). When it asks, please explain what
   each question means in plain English before I answer, and recommend the
   safe default.

3. If anything fails, fix it. Don't ask me to debug — just figure out what
   went wrong and try a different approach. Tell me what you're doing.

4. When the installer finishes, start FediHome (npm start in the install
   folder) and open http://localhost:3000/setup in my browser.

5. Walk me through the setup wizard. Explain each field. For my fediverse
   handle, suggest one based on my name if I'm stuck.

6. When everything is working, give me a one-paragraph summary of what's
   running, where my data lives, and how to update it later.

Go.
```

That's it. Claude Code will take it from here.

---

## What Claude Code will do

Behind the scenes, it'll:

- Check whether you have Node.js, git, and PostgreSQL installed
- Install anything that's missing (asking you first)
- Create a database for your content
- Generate a secure admin password
- Clone the FediHome code
- Build the app
- Start the server
- Open the setup wizard in your browser

You'll be asked a handful of yes/no questions along the way. The AI will explain each one. If you're not sure, just go with the default — they're chosen to be safe.

---

## When things go wrong

If you see an error, **just paste it into Claude Code**. Don't try to interpret it. The AI will:

1. Read the error
2. Tell you in plain English what it means
3. Try a fix
4. Verify the fix worked before moving on

You can also ask things like:
- *"Is this safe to run?"* — it'll explain any command before executing
- *"Can you undo that?"* — it'll roll back where possible
- *"Stop and explain what we just did"* — it'll summarise so far

---

## Going public (your own domain)

Once FediHome is running on `localhost:3000`, your next step is putting it on the internet so people can find you at `@you@yourdomain.com`. Easiest path for non-technical users:

```
Now I want to make my FediHome accessible from the internet using a custom
domain I own. I want to use Cloudflare Tunnel because it's free and doesn't
require opening any ports on my router.

Please read FediHome's docs/cloudflare-tunnel.md guide and walk me through
the setup. My domain is: YOURDOMAIN.COM   ← replace this with your actual domain

Explain each step before doing it. Pause when I need to do something in the
Cloudflare dashboard (like clicking a button) and tell me exactly what to
click.
```

Replace `YOURDOMAIN.COM` with the domain you own (e.g. `janesmith.com`). If you don't own a domain yet, ask Claude Code where to buy one — it'll point you at registrars like Cloudflare Registrar, Namecheap, or Porkbun, all of which are non-tech-friendly.

---

## Updating later

Whenever the FediHome maintainers push new features or bug fixes, your admin notification bell will show a "FediHome update available" item with a list of what's new. To apply it:

```
There's a new FediHome update available. Please apply it for me.

Run: cd ~/fedihome-install/fedihome && npm run update

Review the changes it shows, confirm the update, and let me know when it's
done and what's new.
```

That's it. The `npm run update` command handles everything: pulling new code, installing dependencies, updating the database schema, rebuilding, and restarting the server. Claude Code reviews the changes with you before applying them.

---

## Common questions

**"Will the AI break my computer?"**
No. Claude Code asks permission before running anything that changes your system. You can deny any individual command. The worst case is it installs PostgreSQL and Node.js — both of which are standard tools used by millions of people, easy to remove later.

**"Do I need to keep Claude Code open after install?"**
No. Once FediHome is installed, it runs on its own. You only need Claude Code when you want to update it, troubleshoot, or change something.

**"What if Claude Code suggests something that looks scary?"**
Ask it to explain. *"What does this command do? Could it delete my files? Is there a safer way?"* It will answer honestly, and you stay in control.

**"My install is on a remote server — can I still use this?"**
Yes. SSH into the server first (`ssh user@your-server`) then run `claude` in your home directory. Claude Code works the same way over SSH.

---

## After install: where to go next

- Setup wizard: [http://localhost:3000/setup](http://localhost:3000/setup)
- [Getting Started](getting-started.md) — first 10 minutes
- [Cloudflare Tunnel](cloudflare-tunnel.md) — recommended for home servers
- [Deployment](deployment.md) — production setups
- [Bluesky Integration](bluesky-integration.md) — crosspost to Bluesky
- [Theming](theming.md) — make it your own

Welcome to your home on the Fediverse.
